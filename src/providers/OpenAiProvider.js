import OpenAI from "openai";
import Provider from "./Provider.js";
import { getConfigVariable } from "../util.js";

export default class OpenAiProvider extends Provider {
  #openai;
  #modelName;
  #defaultOptions = {};

  constructor() {
    super();

    const apiKey = getConfigVariable("OPENAI_API_KEY");
    this.#modelName = getConfigVariable("OPENAI_MODEL", "gpt-4-turbo-preview");

    this.#defaultOptions = {
      temperature: parseFloat(getConfigVariable("OPENAI_TEMPERATURE", "0.7")),
      max_tokens: 2048
    };

    this.#openai = new OpenAI({ apiKey });
  }

  /**
   * Gets a text completion from OpenAI's API.
   * @param {Object} modelConfiguration - The model configuration to use for completion
   * @param {Object} [modelOptions={}] - Additional OpenAI model options to override defaults
   * @param {number} [modelOptions.temperature] - Sampling temperature (0.0-2.0), overrides default
   * @param {number} [modelOptions.max_tokens] - Maximum tokens to generate, overrides default
   * @returns {Promise<Object>} Promise resolving to the completed text from OpenAI
   * @throws {OpenAiException} When OpenAI API call fails or returns an error
   */
  async getCompletion(modelConfiguration, modelOptions = {}) {
    console.debug(`[OpenAiProvider] getCompletion called`);
    console.debug(`[OpenAiProvider] Model configuration:`, JSON.stringify(modelConfiguration));
    console.debug(`[OpenAiProvider] Model options:`, JSON.stringify(modelOptions));

    try {
      const messages = [
        {
          role: "user",
          content: modelConfiguration.prompt
        }
      ];

      const completionConfig = {
        model: this.#modelName,
        messages,
        ...this.#defaultOptions,
        ...modelOptions,
      };

      if (modelConfiguration.responseSchema) {
        completionConfig.response_format = {
          type: "json_schema",
          json_schema: {
            name: "response",
            schema: modelConfiguration.responseSchema,
            strict: true
          }
        };
      }

      console.debug(`[OpenAiProvider] Final completion config:`, completionConfig);

      const response = await this.#openai.chat.completions.create(completionConfig);

      const content = response.choices[0].message.content;
      console.debug(`[OpenAiProvider] Received response:`, content);

      return JSON.parse(content);
    } catch (error) {
      console.error(`[OpenAiProvider] Error:`, error.message);
      throw new OpenAiException(error.message, error);
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

class OpenAiException extends Error {
  #cause;

  constructor(message, cause = null) {
    super(`Error while communicating with OpenAI: ${message}`);
    this.#cause = cause;
  }

  get cause() {
    return this.#cause;
  }
}
