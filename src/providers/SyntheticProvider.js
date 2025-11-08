import Provider from "./Provider.js";
import { getConfigVariable } from "../util.js";

export default class SyntheticProvider extends Provider {
    #apiKey;
    #baseUrl;
    #modelName;
    #defaultOptions = {};

    constructor() {
        super();

        this.#apiKey = getConfigVariable("SYNTHETIC_API_KEY");
        this.#baseUrl = getConfigVariable("SYNTHETIC_BASE_URL", "https://synthetic.xdelloco.xyz");
        this.#modelName = getConfigVariable("SYNTHETIC_MODEL", "hf:Qwen/Qwen3-235B-A22B-Instruct-2507");

        this.#defaultOptions = {
            temperature: parseFloat(getConfigVariable("SYNTHETIC_TEMPERATURE", "0.7")),
        };
    }

    /**
     * Gets a text completion from Synthetic.new API.
     * @param {Object} modelConfiguration - The model configuration to use for completion
     * @param {Object} [modelOptions={}] - Additional model options to override defaults
     * @param {number} [modelOptions.temperature] - Sampling temperature (0.0-2.0), overrides default
     * @param {number} [modelOptions.max_tokens] - Maximum tokens to generate, overrides default
     * @returns {Promise<Object>} Promise resolving to the completed text from Synthetic.new
     * @throws {SyntheticProviderException} When API call fails or returns an error
     */
    async getCompletion(modelConfiguration, modelOptions = {}) {
        console.debug(`[SyntheticProvider] getCompletion called`);
        console.debug(`[SyntheticProvider] Model configuration:`, JSON.stringify(modelConfiguration));
        console.debug(`[SyntheticProvider] Model options:`, JSON.stringify(modelOptions));

        try {
            const messages = [
                {
                    role: "user",
                    content: modelConfiguration.prompt
                }
            ];

            const requestBody = {
                messages: messages,
                model: this.#modelName,
                ...this.#defaultOptions,
                ...modelOptions,
            };

            if (modelConfiguration.responseSchema) {
                requestBody.response_format = {
                    type: "json_schema",
                    json_schema: {
                        name: "response",
                        schema: modelConfiguration.responseSchema,
                        strict: true
                    }
                };
            }

            console.debug(`[SyntheticProvider] Final request body:`, JSON.stringify(requestBody));

            const response = await fetch(`${this.#baseUrl}/api/synthetic/chat/completions`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.#apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            console.debug(`[SyntheticProvider] Received response:`, JSON.stringify(data));

            const content = data.choices?.[0]?.message?.content;

            if (!content) {
                throw new Error("No content found in response");
            }

            console.debug(`[SyntheticProvider] Extracted content:`, content);

            return JSON.parse(content.trim());
        } catch (error) {
            console.error(`[SyntheticProvider] Error:`, error.message);
            throw new SyntheticProviderException(error.message, error);
        }
    }

    async getClassificationPrompt({categories, destinationName, description, metadata = {}}) {
        const categoryList = categories.join(", ");

        const responseSchema = {
            type: "object",
            properties: {
                category: {
                    type: "string",
                    enum: categories,
                },
            },
            required: ["category"],
            additionalProperties: false
        };

        const prompt = `You are an automated financial transaction classifier. Categorize this transaction:

        TRANSACTION DATA:
        - Destination: "${destinationName}"
        - Description: "${description}"

        Available categories: [${categoryList}]

        Choose the most appropriate category from the list above.`;

        return {responseSchema, prompt};
    }

    async getExpenseAccountCreationPrompt({description, destinationName, metadata = {}}) {
        const responseSchema = {
            type: "object",
            properties: {
                decision: {
                    type: "string",
                    enum: ["create"],
                    description: "Always 'create' for new account generation"
                },
                account: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description: "Specific merchant or brand name (2-4 words ideally)"
                        },
                        description: {
                            type: "string",
                            description: "Brief description of what this account covers"
                        }
                    },
                    required: ["name", "description"],
                    additionalProperties: false
                }
            },
            required: ["decision", "account"],
            additionalProperties: false
        };

        const prompt = `You are creating specific expense accounts for financial transactions. Your goal is to create accounts using the actual merchant/brand name rather than generic categories.

        TRANSACTION DATA:
        - Description: "${description}"
        - Merchant/Location: ${destinationName || 'Not specified'}

        RULES FOR ACCOUNT NAMING:
        1. ALWAYS prefer the actual merchant/brand name over generic categories
        2. Use the exact business name if available and recognizable
        3. Only use generic names when the merchant is unclear (like "ATM Withdrawal")
        4. Keep names concise but descriptive (2-4 words ideally)

        EXAMPLES:
        GOOD: "Starbucks Coffee", "Shell Gas Station", "Amazon Purchase", "Walmart Groceries"
        BAD: "Coffee Shop", "Gas Station", "Online Shopping", "Grocery Store"

        Create an appropriate expense account for this transaction.`;

        return {responseSchema, prompt};
    }
}

class SyntheticProviderException extends Error {
    #cause;

    constructor(message, cause = null) {
        super(`Error while communicating with Synthetic.new: ${message}`);
        this.#cause = cause;
    }

    get cause() {
        return this.#cause;
    }
}
