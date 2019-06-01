import { Pass } from "./pass";
import { Certificates, isValid } from "./schema";

import { promisify } from "util";
import { readFile as _readFile, readdir as _readdir } from "fs";
import * as path from "path";
import forge from "node-forge";
import formatMessage from "./messages";
import { removeHidden } from "./utils";

const readDir = promisify(_readdir);
const readFile = promisify(_readFile);

interface BundleUnit {
	[key: string]: Buffer;
}

interface PartitionedBundle {
	bundle: BundleUnit;
	l10nBundle: {
		[key: string]: BundleUnit
	};
}

interface FinalCertificates {
	wwdr: forge.pki.Certificate;
	signerCert: forge.pki.Certificate;
	signerKey: forge.pki.PrivateKey;
}

interface FactoryOptions {
	model: string | BundleUnit,
	certificates: Certificates;
	overrides?: Object;
}

export async function createPass(options: FactoryOptions) {
	if (!(options && Object.keys(options).length)) {
		throw new Error("Unable to create Pass: no options were passed");
	}

	// Voglio leggere i certificati
	// Voglio leggere il model (se non è un oggetto)

	try {
		const [model, certificates] = await Promise.all([
			getModelContents(options.model),
		readCertificatesFromOptions(options.certificates)
	]);
	} catch (err) {
		// @TODO: analyze the error and stop the execution somehow
	}

	// Controllo se il model è un oggetto o una stringa
	// Se è un oggetto passo avanti
	// Se è una stringa controllo se è un path. Se è un path
	// faccio readdir
	// altrimenti throw

	// Creare una funzione che possa controllare ed estrarre i certificati
	// Creare una funzione che possa controllare ed estrarre i file
	// Entrambe devono ritornare Promise, così faccio await Promise.all

	return new Pass();
}

async function getModelContents(model: FactoryOptions["model"]) {
	if (!(model && (typeof model === "string" || (typeof model === "object" && Object.keys(model).length)))) {
		throw new Error("Unable to create Pass: invalid model provided");
	}

	let modelContents: PartitionedBundle;

	if (typeof model === "string") {
		modelContents = await getModelFolderContents(model);
	} else {
		modelContents = getModelBufferContents(model);
	}

	const modelFiles = Object.keys(modelContents);

	if (!(modelFiles.includes("pass.json") && modelFiles.some(file => file.includes("icon")))) {
		throw new Error("missing icon or pass.json");
	}

	return modelContents;
}

/**
 * Reads and model contents and creates a splitted
 * bundles-object.
 * @param model
 */

async function getModelFolderContents(model: string): Promise<PartitionedBundle> {
	const modelPath = path.resolve(model) + (!!model && !path.extname(model) ? ".pass" : "");
	const modelFilesList = await readDir(modelPath);

	// No dot-starting files, manifest and signature
	const filteredFiles = removeHidden(modelFilesList).filter(f => !/(manifest|signature|pass)/i.test(f));

	// Icon is required to proceed
	if (!(filteredFiles.length && filteredFiles.some(file => file.toLowerCase().includes("icon")))) {
		const eMessage = formatMessage("MODEL_UNINITIALIZED", path.parse(this.model).name);
		throw new Error(eMessage);
	}

	// Splitting files from localization folders
	const rawBundle = filteredFiles.filter(entry => !entry.includes(".lproj"));
	const l10nFolders = filteredFiles.filter(entry => entry.includes(".lproj"));

	const bundleBuffers = rawBundle.map(file => readFile(path.resolve(model, file)));
	const buffers = await Promise.all(bundleBuffers);

	const bundle: BundleUnit = Object.assign({},
		...rawBundle.map((fileName, index) => ({ [fileName]: buffers[index] }))
	);

	// Reading concurrently localizations folder
	// and their files and their buffers
	const L10N_FilesListByFolder: Array<BundleUnit> = await Promise.all(
		l10nFolders.map(folderPath => {
			// Reading current folder
			const currentLangPath = path.join(model, folderPath);
			return readDir(currentLangPath)
				.then(files => {
					// Transforming files path to a model-relative path
					const validFiles = removeHidden(files)
						.map(file => path.join(currentLangPath, file));

					// Getting all the buffers from file paths
					return Promise.all([
						...validFiles.map(file =>
							readFile(file).catch(() => Buffer.alloc(0))
						)
					]).then(buffers =>
						// Assigning each file path to its buffer
						validFiles.reduce<BundleUnit>((acc, file, index) => {
							if (!buffers[index].length) {
								return acc;
							}

							return { ...acc, [file]: buffers[index] };
						}, {})
					);
				});
		})
	);

	const l10nBundle: PartitionedBundle["l10nBundle"] = Object.assign(
		{},
		...L10N_FilesListByFolder
			.map((folder, index) => ({ [l10nFolders[index]]: folder }))
	);

	return {
		bundle,
		l10nBundle
	};
}

/**
 * Analyzes the passed buffer model and splits it to
 * return buffers and localization files buffers.
 * @param model
 */

function getModelBufferContents(model: BundleUnit): PartitionedBundle {
	const rawBundle = removeHidden(Object.keys(model)).reduce<BundleUnit>((acc, current) => {
		// Checking if current file is one of the autogenerated ones or if its
		// content is not available
		if (/(manifest|signature)/.test(current) || !rawBundle[current]) {
			return acc;
		}

		return { ...acc, [current]: model[current] };
	}, {});

	const bundleKeys = Object.keys(rawBundle);

	if (!bundleKeys.length) {
		throw new Error("Cannot proceed with pass creation: bundle initialized")
	}

	// separing localization folders
	const l10nFolders = bundleKeys.filter(file => file.includes(".lproj"));
	const l10nBundle: PartitionedBundle["l10nBundle"] = Object.assign({},
		...l10nFolders.map<BundleUnit>(folder =>
			({ [folder]: rawBundle[folder] })
		)
	);

	const bundle: BundleUnit = Object.assign({},
		...bundleKeys
			.filter(file => !file.includes(".lproj"))
			.map(file => ({ [file]: rawBundle[file] }))
	);

	return {
		bundle,
		l10nBundle
	};
}

/**
 * Reads certificate contents, if the passed content is a path,
 * and parses them as a PEM.
 * @param options
 */

async function readCertificatesFromOptions(options: Certificates): Promise<FinalCertificates> {
	if (!(options && Object.keys(options).length && isValid(options, "certificatesSchema"))) {
		throw new Error("Unable to create Pass: certificates schema validation failed.");
	}

	// if the signerKey is an object, we want to get
	// all the real contents and don't care of passphrase
	const flattenedDocs = Object.assign({}, options, {
		signerKey: (
			typeof options.signerKey === "string"
			? options.signerKey
			: options.signerKey.keyFile
		)
	});

	// We read the contents
	const rawContentsPromises = Object.keys(flattenedDocs)
		.map(content => {
			if (!!path.parse(content).ext) {
				// The content is a path to the document
				return readFile(path.resolve(content), { encoding: "utf8"});
			} else {
				// Content is the real document content
				return Promise.resolve(content);
			}
		});

	try {
		const parsedContents = await Promise.all(rawContentsPromises);
		const pemParsedContents = parsedContents.map((file, index) => {
			const certName = Object.keys(options)[index];
			const pem = parsePEM(
				certName,
				file,
				typeof options.signerKey === "object"
					? options.signerKey.passphrase
					: undefined
			);

			if (!pem) {
				throw new Error(formatMessage("INVALID_CERTS", certName));
			}

			return { [certName]: pem };
		});

		return Object.assign({}, ...pemParsedContents);
	} catch (err) {
		if (!err.path) {
			throw err;
		}

		throw new Error(formatMessage("INVALID_CERT_PATH", path.parse(err.path).base));
	}
}

/**
 * Parses the PEM-formatted passed text (certificates)
 *
 * @param element - Text content of .pem files
 * @param passphrase - passphrase for the key
 * @returns The parsed certificate or key in node forge format
 */

function parsePEM(pemName: string, element: string, passphrase?: string) {
	if (pemName === "signerKey" && passphrase) {
		return forge.pki.decryptRsaPrivateKey(element, String(passphrase));
	} else {
		return forge.pki.certificateFromPem(element);
	}
}

module.exports = { createPass };
