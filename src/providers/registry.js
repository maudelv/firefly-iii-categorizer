import {getConfigVariable, MissingEnvironmentVariableException} from "../util.js";
import OpenAiProvider from "./OpenAiProvider.js";
import GeminiProvider from "./GeminiProvider.js";
import SyntheticProvider from "./SyntheticProvider.js";

const PROVIDER_FACTORIES = new Map([
    ["openai", () => new OpenAiProvider()],
    ["gemini", () => new GeminiProvider()],
    ["synthetic", () => new SyntheticProvider()],
]);

export class ProviderConfigurationError extends Error {
    constructor(message, options = {}) {
        super(message, options);
    }
}

export function createProviderFromConfig() {
    const selectedProvider = getConfigVariable("AI_PROVIDER", "openai").toLowerCase();
    const factory = PROVIDER_FACTORIES.get(selectedProvider);

    if (!factory) {
        throw new ProviderConfigurationError(`AI_PROVIDER '${selectedProvider}' is not supported. Supported providers: ${Array.from(PROVIDER_FACTORIES.keys()).join(", ")}`);
    }

    try {
        return factory();
    } catch (error) {
        if (error instanceof MissingEnvironmentVariableException) {
            throw new ProviderConfigurationError(`Provider '${selectedProvider}' is missing required configuration: ${error.variableName}`, {cause: error});
        }

        throw error;
    }
}

export function listProviders() {
    return Array.from(PROVIDER_FACTORIES.keys());
}
