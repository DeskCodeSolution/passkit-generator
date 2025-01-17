import * as path from "path";
import forge from "node-forge";
import formatMessage, { ERROR, DEBUG } from "./messages";
import * as Schemas from "./schemas";
import {
	removeHidden,
	splitBufferBundle,
	getAllFilesWithName,
	hasFilesWithName,
	deletePersonalization,
} from "./utils";
import fs from "fs";
import debug from "debug";

const prsDebug = debug("Personalization");
const { readdir: readDir, readFile } = fs.promises;

/**
 * Performs checks on the passed model to
 * determine how to parse it
 * @param model
 */

export async function getModelContents(model: Schemas.FactoryOptions["model"]) {
	let modelContents: Schemas.PartitionedBundle;

	if (typeof model === "string") {
		modelContents = await getModelFolderContents(model);
	} else if (typeof model === "object" && Object.keys(model).length) {
		modelContents = getModelBufferContents(model);
	} else {
		throw new Error(formatMessage(ERROR.MODEL_NOT_VALID));
	}

	const modelFiles = Object.keys(modelContents.bundle);
	const isModelInitialized =
		modelFiles.includes("pass.json") &&
		hasFilesWithName("icon", modelFiles, "startsWith");

	if (!isModelInitialized) {
		throw new Error(
			formatMessage(ERROR.MODEL_UNINITIALIZED, "parse result"),
		);
	}

	// ======================= //
	// *** Personalization *** //
	// ======================= //

	const personalizationJsonFile = "personalization.json";

	if (!modelFiles.includes(personalizationJsonFile)) {
		return modelContents;
	}

	const logoFullNames = getAllFilesWithName(
		"personalizationLogo",
		modelFiles,
		"startsWith",
	);
	if (
		!(
			logoFullNames.length &&
			modelContents.bundle[personalizationJsonFile].length
		)
	) {
		deletePersonalization(modelContents.bundle, logoFullNames);
		return modelContents;
	}

	try {
		const parsedPersonalization = JSON.parse(
			modelContents.bundle[personalizationJsonFile].toString("utf8"),
		);
		const isPersonalizationValid = Schemas.isValid(
			parsedPersonalization,
			Schemas.Personalization,
		);

		if (!isPersonalizationValid) {
			[...logoFullNames, personalizationJsonFile].forEach(
				(file) => delete modelContents.bundle[file],
			);

			return modelContents;
		}
	} catch (err) {
		prsDebug(formatMessage(DEBUG.PRS_INVALID, err));
		deletePersonalization(modelContents.bundle, logoFullNames);
	}

	return modelContents;
}

/**
 * Reads and model contents and creates a splitted
 * bundles-object.
 * @param model
 */

export async function getModelFolderContents(
	model: string,
): Promise<Schemas.PartitionedBundle> {
	try {
		const modelPath = `${model}${(!path.extname(model) && ".pass") || ""}`;
		const modelFilesList = await readDir(modelPath);

		// No dot-starting files, manifest and signature
		const filteredFiles = removeHidden(modelFilesList).filter(
			(f) =>
				!/(manifest|signature)/i.test(f) &&
				/.+$/.test(path.parse(f).ext),
		);

		const isModelInitialized =
			filteredFiles.length &&
			hasFilesWithName("icon", filteredFiles, "startsWith");

		// Icon is required to proceed
		if (!isModelInitialized) {
			throw new Error(
				formatMessage(
					ERROR.MODEL_UNINITIALIZED,
					path.parse(model).name,
				),
			);
		}

		// Splitting files from localization folders
		const rawBundleFiles = filteredFiles.filter(
			(entry) => !entry.includes(".lproj"),
		);
		const l10nFolders = filteredFiles.filter((entry) =>
			entry.includes(".lproj"),
		);

		const rawBundleBuffers = await Promise.all(
			rawBundleFiles.map((file) =>
				readFile(path.resolve(modelPath, file)),
			),
		);

		const bundle: Schemas.BundleUnit = Object.assign(
			{},
			...rawBundleFiles.map((fileName, index) => ({
				[fileName]: rawBundleBuffers[index],
			})),
		);

		// Reading concurrently localizations folder
		// and their files and their buffers
		const L10N_FilesListByFolder: Array<Schemas.BundleUnit> =
			await Promise.all(
				l10nFolders.map(async (folderPath) => {
					// Reading current folder
					const currentLangPath = path.join(modelPath, folderPath);

					const files = await readDir(currentLangPath);
					// Transforming files path to a model-relative path
					const validFiles = removeHidden(files).map((file) =>
						path.join(currentLangPath, file),
					);

					// Getting all the buffers from file paths
					const buffers = await Promise.all(
						validFiles.map((file) =>
							readFile(file).catch(() => Buffer.alloc(0)),
						),
					);

					// Assigning each file path to its buffer
					// and discarding the empty ones

					return validFiles.reduce<Schemas.BundleUnit>(
						(acc, file, index) => {
							if (!buffers[index].length) {
								return acc;
							}

							const fileComponents = file.split(path.sep);
							const fileName =
								fileComponents[fileComponents.length - 1];

							return {
								...acc,
								[fileName]: buffers[index],
							};
						},
						{},
					);
				}),
			);

		const l10nBundle: Schemas.PartitionedBundle["l10nBundle"] =
			Object.assign(
				{},
				...L10N_FilesListByFolder.map((folder, index) => ({
					[l10nFolders[index]]: folder,
				})),
			);

		return {
			bundle,
			l10nBundle,
		};
	} catch (err) {
		if (err?.code === "ENOENT") {
			if (err.syscall === "open") {
				// file opening failed
				throw new Error(
					formatMessage(ERROR.MODELF_NOT_FOUND, err.path),
				);
			} else if (err.syscall === "scandir") {
				// directory reading failed
				const pathContents = (err.path as string).split(/(\/|\\\?)/);
				throw new Error(
					formatMessage(
						ERROR.MODELF_FILE_NOT_FOUND,
						pathContents[pathContents.length - 1],
					),
				);
			}
		}

		throw err;
	}
}

/**
 * Analyzes the passed buffer model and splits it to
 * return buffers and localization files buffers.
 * @param model
 */

export function getModelBufferContents(
	model: Schemas.BundleUnit,
): Schemas.PartitionedBundle {
	const rawBundle = removeHidden(
		Object.keys(model),
	).reduce<Schemas.BundleUnit>((acc, current) => {
		// Checking if current file is one of the autogenerated ones or if its
		// content is not available

		if (/(manifest|signature)/.test(current) || !model[current]) {
			return acc;
		}

		return { ...acc, [current]: model[current] };
	}, {});

	const bundleKeys = Object.keys(rawBundle);

	const isModelInitialized =
		bundleKeys.length && hasFilesWithName("icon", bundleKeys, "startsWith");

	// Icon is required to proceed
	if (!isModelInitialized) {
		throw new Error(formatMessage(ERROR.MODEL_UNINITIALIZED, "Buffers"));
	}

	// separing localization folders from bundle files
	const [l10nBundle, bundle] = splitBufferBundle(rawBundle);

	return {
		bundle,
		l10nBundle,
	};
}

/**
 * Reads certificate contents, if the passed content is a path,
 * and parses them as a PEM.
 * @param options
 */

type flatCertificates = Omit<Schemas.Certificates, "signerKey"> & {
	signerKey: string;
};

export async function readCertificatesFromOptions(
	options: Schemas.Certificates,
): Promise<Schemas.CertificatesSchema> {
	if (
		!(
			options &&
			Object.keys(options).length &&
			Schemas.isValid(options, Schemas.CertificatesSchema)
		)
	) {
		throw new Error(formatMessage(ERROR.CP_NO_CERTS));
	}

	let signerKey: string;

	if (typeof options.signerKey === "object") {
		signerKey = options.signerKey?.keyFile;
	} else {
		signerKey = options.signerKey;
	}

	// if the signerKey is an object, we want to get
	// all the real contents and don't care of passphrase
	const flattenedDocs = Object.assign({}, options, {
		signerKey,
	}) as flatCertificates;

	// We read the contents
	const rawContentsPromises = Object.keys(flattenedDocs).map((key) => {
		const content = flattenedDocs[key];

		if (!!path.parse(content).ext) {
			// The content is a path to the document
			return readFile(path.resolve(content), { encoding: "utf8" });
		} else {
			// Content is the real document content
			return Promise.resolve(content);
		}
	});

	try {
		const parsedContents = await Promise.all(rawContentsPromises);
		const pemParsedContents = parsedContents.map((file, index) => {
			const certName = Object.keys(options)[index];
			const passphrase =
				(typeof options.signerKey === "object" &&
					options.signerKey?.passphrase) ||
				undefined;

			const pem = parsePEM(certName, file, passphrase);

			if (!pem) {
				throw new Error(formatMessage(ERROR.INVALID_CERTS, certName));
			}

			return { [certName]: pem };
		});

		return Object.assign({}, ...pemParsedContents);
	} catch (err) {
		if (!err.path) {
			throw err;
		}

		throw new Error(
			formatMessage(ERROR.INVALID_CERT_PATH, path.parse(err.path).base),
		);
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
