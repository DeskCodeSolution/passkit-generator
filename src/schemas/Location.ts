import Joi from "joi";

/**
 * @see https://developer.apple.com/documentation/walletpasses/pass/locations
 * @TODO Rename "Location" in "Locations". This will be done in v3.0
 */

export interface Location {
	relevantText?: string;
	altitude?: number;
	latitude: number;
	longitude: number;
}

export const Location = Joi.object<Location>().keys({
	altitude: Joi.number(),
	latitude: Joi.number().required(),
	longitude: Joi.number().required(),
	relevantText: Joi.string(),
});
