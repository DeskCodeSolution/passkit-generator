import path from "path";
import forge from "node-forge";
import debug from "debug";
import { Stream } from "stream";
import { ZipFile } from "yazl";
import type Joi from "joi";

import * as Schemas from "./schemas";
import formatMessage, { ERROR, DEBUG } from "./messages";
import FieldsArray from "./fieldsArray";
import {
	generateStringFile,
	dateToW3CString,
	isValidRGB,
	deletePersonalization,
	getAllFilesWithName,
} from "./utils";
import * as Signature from "./signature";

const barcodeDebug = debug("passkit:barcode");
const genericDebug = debug("passkit:generic");

const transitType = Symbol("transitType");
const passProps = Symbol("_props");

const propsSchemaMap = new Map<string, Joi.ObjectSchema<any>>([
	["barcodes", Schemas.Barcode],
	["barcode", Schemas.Barcode],
	["beacons", Schemas.Beacon],
	["locations", Schemas.Location],
	["nfc", Schemas.NFC],
]);

export class Pass {
	private bundle: Schemas.BundleUnit;
	private l10nBundles: Schemas.PartitionedBundle["l10nBundle"];
	private _fields: (keyof Schemas.PassFields)[] = [
		"primaryFields",
		"secondaryFields",
		"auxiliaryFields",
		"backFields",
		"headerFields",
	];
	private [passProps]: Schemas.ValidPass = {};
	private type: keyof Schemas.ValidPassType;
	private fieldsKeys: Set<string> = new Set<string>();
	private passCore: Schemas.ValidPass;

	public headerFields: FieldsArray;
	public primaryFields: FieldsArray;
	public secondaryFields: FieldsArray;
	public auxiliaryFields: FieldsArray;
	public backFields: FieldsArray;

	private Certificates: Schemas.CertificatesSchema;
	private [transitType]: string = "";
	private l10nTranslations: {
		[languageCode: string]: { [placeholder: string]: string };
	} = {};

	constructor(options: Schemas.PassInstance) {
		if (!Schemas.isValid(options, Schemas.PassInstance)) {
			throw new Error(formatMessage(ERROR.REQUIR_VALID_FAILED));
		}

		this.Certificates = options.certificates;
		this.l10nBundles = options.model.l10nBundle;
		this.bundle = { ...options.model.bundle };

		try {
			this.passCore = JSON.parse(
				this.bundle["pass.json"].toString("utf8"),
			);
		} catch (err) {
			throw new Error(formatMessage(ERROR.PASSFILE_VALIDATION_FAILED));
		}

		// Parsing the options and extracting only the valid ones.
		const validOverrides = Schemas.getValidated(
			options.overrides || {},
			Schemas.OverridesSupportedOptions,
		);

		if (validOverrides === null) {
			throw new Error(formatMessage(ERROR.OVV_KEYS_BADFORMAT));
		}

		this.type = Object.keys(this.passCore).find((key) =>
			/(boardingPass|eventTicket|coupon|generic|storeCard)/.test(key),
		) as keyof Schemas.ValidPassType;

		if (!this.type) {
			throw new Error(formatMessage(ERROR.NO_PASS_TYPE));
		}

		// Parsing and validating pass.json keys
		const passCoreKeys = Object.keys(
			this.passCore,
		) as (keyof Schemas.ValidPass)[];

		const validatedPassKeys = passCoreKeys.reduce<Schemas.ValidPass>(
			(acc, current) => {
				if (this.type === current) {
					// We want to exclude type keys (eventTicket,
					// boardingPass, ecc.) and their content
					return acc;
				}

				if (!propsSchemaMap.has(current)) {
					// If the property is unknown (we don't care if
					// it is valid or not for Wallet), we return
					// directly the content
					return { ...acc, [current]: this.passCore[current] };
				}

				const currentSchema = propsSchemaMap.get(current)!;

				if (Array.isArray(this.passCore[current])) {
					const valid = getValidInArray<Schemas.ArrayPassSchema>(
						currentSchema,
						this.passCore[current] as Schemas.ArrayPassSchema[],
					);

					return {
						...acc,
						[current]: valid,
					};
				} else {
					return {
						...acc,
						[current]:
							(Schemas.isValid(
								this.passCore[current],
								currentSchema,
							) &&
								this.passCore[current]) ||
							undefined,
					};
				}
			},
			{},
		);

		this[passProps] = {
			...(validatedPassKeys || {}),
			...(validOverrides || {}),
		};

		if (
			this.type === "boardingPass" &&
			this.passCore[this.type]["transitType"]
		) {
			// We might want to generate a boarding pass without setting manually
			// in the code the transit type but right in the model;
			this[transitType] = this.passCore[this.type]["transitType"];
		}

		this._fields.forEach((fieldName) => {
			this[fieldName] = new FieldsArray(
				this.fieldsKeys,
				...(this.passCore[this.type][fieldName] || []).filter((field) =>
					Schemas.isValid(field, Schemas.Field),
				),
			);
		});
	}

	/**
	 * Generates the pass Stream
	 *
	 * @method generate
	 * @return A Stream of the generated pass.
	 */

	generate(): Stream {
		// Editing Pass.json
		this.bundle["pass.json"] = this._patch(this.bundle["pass.json"]);

		/**
		 * Checking Personalization, as this is available only with NFC
		 * @see https://apple.co/2SHfb22
		 */
		const currentBundleFiles = Object.keys(this.bundle);

		if (
			!this[passProps].nfc &&
			currentBundleFiles.includes("personalization.json")
		) {
			genericDebug(formatMessage(DEBUG.PRS_REMOVED));
			deletePersonalization(
				this.bundle,
				getAllFilesWithName(
					"personalizationLogo",
					currentBundleFiles,
					"startsWith",
				),
			);
		}

		const finalBundle: Schemas.BundleUnit = { ...this.bundle };

		/**
		 * Iterating through languages and generating pass.string file
		 */

		const translationsLanguageCodes = Object.keys(this.l10nTranslations);

		for (
			let langs = translationsLanguageCodes.length, lang: string;
			(lang = translationsLanguageCodes[--langs]);

		) {
			const strings = generateStringFile(this.l10nTranslations[lang]);
			const languageBundleDirname = `${lang}.lproj`;

			if (strings.length) {
				/**
				 * if there's already a buffer of the same folder and called
				 * `pass.strings`, we'll merge the two buffers. We'll create
				 * it otherwise.
				 */

				const languageBundleUnit = (this.l10nBundles[
					languageBundleDirname
				] ??= {});

				languageBundleUnit["pass.strings"] = Buffer.concat([
					languageBundleUnit["pass.strings"] || Buffer.alloc(0),
					strings,
				]);
			}

			if (
				!this.l10nBundles[languageBundleDirname] ||
				!Object.keys(this.l10nBundles[languageBundleDirname]).length
			) {
				continue;
			}

			/**
			 * Assigning all the localization files to the final bundle
			 * by mapping the buffer to the pass-relative file path;
			 *
			 * We are replacing the slashes to avoid Windows slashes
			 * composition.
			 */

			const bundleRelativeL10NPaths = Object.entries(
				this.l10nBundles[languageBundleDirname],
			).reduce((acc, [fileName, fileContent]) => {
				const fullPath = path
					.join(languageBundleDirname, fileName)
					.replace(/\\/, "/");

				return {
					...acc,
					[fullPath]: fileContent,
				};
			}, {});

			Object.assign(finalBundle, bundleRelativeL10NPaths);
		}

		/*
		 * Parsing the buffers, pushing them into the archive
		 * and returning the compiled manifest
		 */
		const archive = new ZipFile();
		const manifest = Object.entries(finalBundle).reduce<Schemas.Manifest>(
			(acc, [fileName, buffer]) => {
				let hashFlow = forge.md.sha1.create();

				hashFlow.update(buffer.toString("binary"));
				archive.addBuffer(buffer, fileName);

				return {
					...acc,
					[fileName]: hashFlow.digest().toHex(),
				};
			},
			{},
		);

		const signatureBuffer = Signature.create(manifest, this.Certificates);

		archive.addBuffer(signatureBuffer, "signature");
		archive.addBuffer(
			Buffer.from(JSON.stringify(manifest)),
			"manifest.json",
		);
		const passStream = new Stream.PassThrough();

		archive.outputStream.pipe(passStream);
		archive.end();

		return passStream;
	}

	/**
	 * Adds traslated strings object to the list of translation to be inserted into the pass
	 *
	 * @method localize
	 * @params lang - the ISO 3166 alpha-2 code for the language
	 * @params translations - key/value pairs where key is the
	 * 		placeholder in pass.json localizable strings
	 * 		and value the real translated string.
	 * @returns {this}
	 *
	 * @see https://apple.co/2KOv0OW - Passes support localization
	 */

	localize(
		lang: string,
		translations?: { [placeholder: string]: string },
	): this {
		if (
			lang &&
			typeof lang === "string" &&
			(typeof translations === "object" || translations === undefined)
		) {
			this.l10nTranslations[lang] = translations || {};
		}

		return this;
	}

	/**
	 * Sets expirationDate property to a W3C-formatted date
	 *
	 * @method expiration
	 * @params date
	 * @returns {this}
	 */

	expiration(date: Date | null): this {
		if (date === null) {
			delete this[passProps]["expirationDate"];
			return this;
		}

		const parsedDate = processDate("expirationDate", date);

		if (parsedDate) {
			this[passProps]["expirationDate"] = parsedDate;
		}

		return this;
	}

	/**
	 * Sets voided property to true
	 *
	 * @method void
	 * @return {this}
	 */

	void(): this {
		this[passProps]["voided"] = true;
		return this;
	}

	/**
	 * Sets current pass' relevancy through beacons
	 * @param data varargs with type schema.Beacon, or single arg null
	 * @returns {Pass}
	 */

	beacons(resetFlag: null): this;
	beacons(...data: Schemas.Beacon[]): this;
	beacons(...data: (Schemas.Beacon | null)[]): this {
		if (data[0] === null) {
			delete this[passProps]["beacons"];
			return this;
		}

		const valid = getValidInArray(Schemas.Beacon, data);

		if (valid.length) {
			this[passProps]["beacons"] = valid;
		}

		return this;
	}

	/**
	 * Sets current pass' relevancy through locations
	 * @param data varargs with type schema.Location, or single arg null
	 * @returns {Pass}
	 */

	locations(resetFlag: null): this;
	locations(...data: Schemas.Location[]): this;
	locations(...data: (Schemas.Location | null)[]): this {
		if (data[0] === null) {
			delete this[passProps]["locations"];
			return this;
		}

		const valid = getValidInArray(Schemas.Location, data);

		if (valid.length) {
			this[passProps]["locations"] = valid;
		}

		return this;
	}

	/**
	 * Sets current pass' relevancy through a date
	 * @param data
	 * @returns {Pass}
	 */

	relevantDate(date: Date | null): this {
		if (date === null) {
			delete this[passProps]["relevantDate"];
			return this;
		}

		const parsedDate = processDate("relevantDate", date);

		if (parsedDate) {
			this[passProps]["relevantDate"] = parsedDate;
		}

		return this;
	}

	/**
	 * Adds barcodes "barcodes" property.
	 * It allows to pass a string to autogenerate all the structures.
	 *
	 * @method barcode
	 * @params first - a structure or the string (message) that will generate
	 * 		all the barcodes
	 * @params data - other barcodes support
	 * @return {this} Improved this with length property and other methods
	 */

	barcodes(resetFlag: null): this;
	barcodes(message: string): this;
	barcodes(...data: Schemas.Barcode[]): this;
	barcodes(...data: (Schemas.Barcode | null | string)[]): this {
		if (data[0] === null) {
			delete this[passProps]["barcodes"];
			return this;
		}

		if (typeof data[0] === "string") {
			const autogen = barcodesFromUncompleteData(data[0]);

			if (!autogen.length) {
				barcodeDebug(formatMessage(DEBUG.BRC_AUTC_MISSING_DATA));
				return this;
			}

			this[passProps]["barcodes"] = autogen;

			return this;
		} else {
			/**
			 * Stripping from the array not-object elements
			 * and the ones that does not pass validation.
			 * Validation assign default value to missing parameters (if any).
			 */

			const validBarcodes = data.reduce<Schemas.Barcode[]>(
				(acc, current) => {
					if (!(current && current instanceof Object)) {
						return acc;
					}

					const validated = Schemas.getValidated(
						current,
						Schemas.Barcode,
					);

					if (
						!(
							validated &&
							validated instanceof Object &&
							Object.keys(validated).length
						)
					) {
						return acc;
					}

					return [...acc, validated];
				},
				[],
			);

			if (validBarcodes.length) {
				this[passProps]["barcodes"] = validBarcodes;
			}

			return this;
		}
	}

	/**
	 * Given an index <= the amount of already set "barcodes",
	 * this let you choose which structure to use for retrocompatibility
	 * property "barcode".
	 *
	 * @method barcode
	 * @params format - the format to be used
	 * @return {this}
	 */

	barcode(chosenFormat: Schemas.BarcodeFormat | null): this {
		const { barcodes } = this[passProps];

		if (chosenFormat === null) {
			delete this[passProps]["barcode"];
			return this;
		}

		if (typeof chosenFormat !== "string") {
			barcodeDebug(formatMessage(DEBUG.BRC_FORMATTYPE_UNMATCH));
			return this;
		}

		if (chosenFormat === "PKBarcodeFormatCode128") {
			barcodeDebug(formatMessage(DEBUG.BRC_BW_FORMAT_UNSUPPORTED));
			return this;
		}

		if (!(barcodes && barcodes.length)) {
			barcodeDebug(formatMessage(DEBUG.BRC_NO_POOL));
			return this;
		}

		// Checking which object among barcodes has the same format of the specified one.
		const index = barcodes.findIndex((b) =>
			b.format.toLowerCase().includes(chosenFormat.toLowerCase()),
		);

		if (index === -1) {
			barcodeDebug(formatMessage(DEBUG.BRC_NOT_SUPPORTED));
			return this;
		}

		this[passProps]["barcode"] = barcodes[index];
		return this;
	}

	/**
	 * Sets nfc fields in properties
	 *
	 * @method nfc
	 * @params data - the data to be pushed in the pass
	 * @returns {this}
	 * @see https://apple.co/2wTxiaC
	 */

	nfc(data: Schemas.NFC | null): this {
		if (data === null) {
			delete this[passProps]["nfc"];
			return this;
		}

		if (
			!(
				data &&
				typeof data === "object" &&
				!Array.isArray(data) &&
				Schemas.isValid(data, Schemas.NFC)
			)
		) {
			genericDebug(formatMessage(DEBUG.NFC_INVALID));
			return this;
		}

		this[passProps]["nfc"] = data;

		return this;
	}

	/**
	 * Allows to get the current inserted props;
	 * will return all props from valid overrides,
	 * template's pass.json and methods-inserted ones;
	 *
	 * @returns The properties will be inserted in the pass.
	 */

	get props(): Readonly<Schemas.ValidPass> {
		return this[passProps];
	}

	/**
	 * Edits the buffer of pass.json based on the passed options.
	 *
	 * @method _patch
	 * @params {Buffer} passBuffer - Buffer of the contents of pass.json
	 * @returns {Promise<Buffer>} Edited pass.json buffer or Object containing error.
	 */

	private _patch(passCoreBuffer: Buffer): Buffer {
		const passFile = JSON.parse(
			passCoreBuffer.toString(),
		) as Schemas.ValidPass;

		if (Object.keys(this[passProps]).length) {
			/*
			 * We filter the existing (in passFile) and non-valid keys from
			 * the below array keys that accept rgb values
			 * and then delete it from the passFile.
			 */

			const passColors = [
				"backgroundColor",
				"foregroundColor",
				"labelColor",
			] as Array<keyof Schemas.PassColors>;

			passColors
				.filter(
					(v) =>
						this[passProps][v] && !isValidRGB(this[passProps][v]),
				)
				.forEach((v) => delete this[passProps][v]);

			Object.assign(passFile, this[passProps]);
		}

		this._fields.forEach((field) => {
			passFile[this.type][field] = this[field];
		});

		if (this.type === "boardingPass" && !this[transitType]) {
			throw new Error(formatMessage(ERROR.TRSTYPE_REQUIRED));
		}

		passFile[this.type]["transitType"] = this[transitType];

		return Buffer.from(JSON.stringify(passFile));
	}

	set transitType(value: string) {
		if (!Schemas.isValid(value, Schemas.TransitType)) {
			genericDebug(formatMessage(DEBUG.TRSTYPE_NOT_VALID, value));
			this[transitType] = this[transitType] || "";
			return;
		}

		this[transitType] = value;
	}

	get transitType(): string {
		return this[transitType];
	}
}

/**
 * Automatically generates barcodes for all the types given common info
 *
 * @method barcodesFromUncompleteData
 * @params message - the content to be placed inside "message" field
 * @return Array of barcodeDict compliant
 */

function barcodesFromUncompleteData(message: string): Schemas.Barcode[] {
	if (!(message && typeof message === "string")) {
		return [];
	}

	return (
		[
			"PKBarcodeFormatQR",
			"PKBarcodeFormatPDF417",
			"PKBarcodeFormatAztec",
			"PKBarcodeFormatCode128",
		] as Array<Schemas.BarcodeFormat>
	).map((format) =>
		Schemas.getValidated({ format, message }, Schemas.Barcode),
	);
}

function getValidInArray<T>(
	schemaName: Joi.ObjectSchema<T>,
	contents: T[],
): T[] {
	return contents.filter(
		(current) =>
			Object.keys(current).length && Schemas.isValid(current, schemaName),
	);
}

function processDate(key: string, date: Date): string | null {
	if (!(date instanceof Date)) {
		return null;
	}

	const dateParse = dateToW3CString(date);

	if (!dateParse) {
		genericDebug(formatMessage(DEBUG.DATE_FORMAT_UNMATCH, key));
		return null;
	}

	return dateParse;
}
