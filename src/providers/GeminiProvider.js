import { GoogleGenerativeAI } from "@google/generative-ai";
import Provider from "./Provider.js";
import { getConfigVariable } from "../util.js";

export default class GeminiProvider extends Provider {
  #model;
  #modelName;
  #defaultOptions = {};

  constructor() {
    super();

    const apiKey = getConfigVariable("GEMINI_API_KEY");
    this.#modelName = getConfigVariable("GEMINI_MODEL", "gemini-2.5-flash");

    this.#defaultOptions = {
      temperature: parseFloat(getConfigVariable("GEMINI_TEMPERATURE", "0.3")),
      maxOutputTokens: 2048
    };

    const client = new GoogleGenerativeAI(apiKey);
    this.#model = client.getGenerativeModel({
      model: this.#modelName,
      generationConfig: this.#defaultOptions
    });
  }

  /**
   * Gets a text completion from Gemini's API.
   * @param {Object} modelConfiguration - The model configuration to use for completion
   * @param {Object} [modelOptions={}] - Additional Gemini model options to override defaults
   * @param {number} [modelOptions.temperature] - Sampling temperature (0.0-2.0), overrides default
   * @param {number} [modelOptions.maxOutputTokens] - Maximum tokens to generate, overrides default
   * @returns {Promise<Object>} Promise resolving to the completed text from Gemini
   * @throws {GeminiProviderException} When Gemini API call fails or returns an error
   */
  // I don't think modelConfiguration is an good name, it works for now ig.
  async getCompletion(modelConfiguration, modelOptions = {}) {
    console.debug(`[GeminiProvider] getCompletion called`);
    console.debug(`[GeminiProvider] Model configuration:`, JSON.stringify(modelConfiguration));
    console.debug(`[GeminiProvider] Model options:`, JSON.stringify(modelOptions));

    // Gemini uses maxOutputTokens instead of max_tokens, so we need to convert it.
    const passedOptions = { ...modelOptions };
    if (passedOptions.max_tokens) {
      passedOptions.maxOutputTokens = passedOptions.max_tokens;
      delete passedOptions.max_tokens;
    }

    try {
      const generationConfig = {
        ...this.#defaultOptions,
        ...passedOptions,
        responseMimeType: modelConfiguration.responseMimeType || "application/json",
        responseSchema: modelConfiguration.responseSchema || {type: "object"}
      };

      console.debug(`[GeminiProvider] Final generation config:`, generationConfig);

      const result = await this.#model.generateContent({
        contents: [{ parts: [{ text: modelConfiguration.prompt }] }],
        generationConfig
      });

      let text = result.response.text();
      console.debug(`[GeminiProvider] Received response:`, text);

      return JSON.parse(text);
    } catch (error) {
      console.error(`[GeminiProvider] Error:`, error.message);
      throw new GeminiProviderException(error.message, error);
    }
  }

  async getClassificationPrompt({categories, destinationName, description, metadata = {}}) {
      const categoryList = categories.join(", ");
      const responseMimeType = "application/json";
      const responseSchema = {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: categories,
          },
        },
        required: ["category"],
      };
      const prompt = `You are an automated financial transaction classifier. Categorize this transaction:

      TRANSACTION DATA:
      - Destination: "${destinationName}"
      - Description: "${description}"

      Available categories: [${categoryList}]

      Choose the most appropiate category from the list above.`;
      return {responseMimeType, responseSchema, prompt};
  }

  async getExpenseAccountCreationPrompt({description, destinationName, metadata = {}}) {
    const responseMimeType = "application/json";
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
                required: ["name", "description"]
            }
        },
        required: ["decision", "account"]
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

    return {responseMimeType, responseSchema, prompt};
  }
}

class GeminiProviderException extends Error {
  #cause;

  constructor(message, cause = null) {
    super(`Error while communicating with Gemini: ${message}`);
    this.#cause = cause;
  }

  get cause() {
    return this.#cause;
  }
}
