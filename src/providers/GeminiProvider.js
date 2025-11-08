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
  * Classifies a transaction using Gemini's completion API.
  * @param {Object} options - The classification options
  * @param {string[]} options.categories - Array of valid category names to classify into
  * @param {string} options.destinationName - Name of the transaction destination/recipient
  * @param {string} options.description - Transaction description or subject line
  * @param {Object} [options.metadata={}] - Additional metadata for the transaction
  * @param {Object} [options.modelOptions={}] - Gemini model options (temperature, maxOutputTokens, etc.)
  * @param {number} [options.modelOptions.temperature] - Sampling temperature (0.0-2.0)
  * @param {number} [options.modelOptions.maxOutputTokens] - Maximum tokens to generate
  * @returns {Promise<Object|null>} Promise resolving to classification result or null if classification failed
  * @returns {string} [returns.prompt] - The exact prompt sent to Gemini
  * @returns {string} [returns.response] - Raw response text from Gemini
  * @returns {string} [returns.category] - The chosen category (must be in options.categories)
  * @throws {GeminiProviderException} When Gemini API call fails (network error, invalid API key, etc.)
  * @throws {GeminiProviderException} When Gemini API response contains an error
  */

  async classify({ categories, destinationName, description, metadata = {}, modelOptions = {} }) {
    // eslint-disable-line no-unused-vars
    try {
      const prompt = this.#buildPrompt(
        categories,
        destinationName,
        description,
      );

      const generationConfig = {
        ...this.#defaultOptions,
        ...modelOptions,
        maxOutputTokens: 2048
      };

      const modelWithConfig = this.#model.startChat({
        generationConfig
      });

      const response = await modelWithConfig.sendMessage(prompt);
      const text = response?.response?.text?.() ?? "";

      const guess = this.#normaliseGuess(text);

      if (!categories.includes(guess)) {
        console.warn(`Gemini could not classify the transaction.
                Prompt: ${prompt}
                Gemini guess: ${guess}`);
        return null;
      }

      return {
        prompt,
        response: text,
        category: guess,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new GeminiProviderException(error.message, error);
      }

      throw new GeminiProviderException(
        "Unknown error while communicating with Gemini",
      );
    }
  }

  /**
   * Gets a text completion from Gemini's API.
   * @param {string} prompt - The text prompt to send to Gemini for completion
   * @param {Object} [modelOptions={}] - Additional Gemini model options to override defaults
   * @param {number} [modelOptions.temperature] - Sampling temperature (0.0-2.0), overrides default
   * @param {number} [modelOptions.maxOutputTokens] - Maximum tokens to generate, overrides default
   * @returns {Promise<string>} Promise resolving to the completed text from Gemini
   * @throws {GeminiProviderException} When Gemini API call fails or returns an error
   */

  async getCompletion(prompt, modelOptions = {}) {
    console.debug(`[GeminiProvider] getCompletion called`);
    console.debug(`[GeminiProvider] Prompt length: ${prompt?.length || 0}`);
    console.debug(`[GeminiProvider] Model options:`, modelOptions);
    console.debug(`[GeminiProvider] Default options:`, this.#defaultOptions);

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
      };

      console.debug(`[GeminiProvider] Final generation config:`, generationConfig);

      const result = await this.#model.generateContent({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig
      });

      console.debug(`[GeminiProvider] Received response:`, result);

      let text = "";

      if (result?.response && typeof result.response.text === 'function') {
        try {
          const textResult = result.response.text();
          console.debug(`[GeminiProvider] response.text() returned:`, typeof textResult, textResult);
          if (typeof textResult === 'string') {
            text = textResult;
          }
        } catch (e) {
          console.error(`[GeminiProvider] Error calling response.text(): ${e.message}`);
        }
      }

      if (!text && result?.response?.candidates?.length > 0) {
        const candidate = result.response.candidates[0];
        if (candidate?.content?.parts?.length > 0) {
          const part = candidate.content.parts[0];
          if (part?.text && typeof part.text === 'string') {
            text = part.text;
          }
        }
      }

      console.debug(`[GeminiProvider] Extracted text: "${text}"`);
      console.debug(`[GeminiProvider] Text length: ${text.length}`);

      // Check if response was truncated
      if (result?.response?.candidates?.length > 0) {
        const finishReason = result.response.candidates[0].finishReason;
        console.debug(`[GeminiProvider] Finish reason: ${finishReason}`);
      }

      if (!text) {
        console.error(`[GeminiProvider] Response structure:`, JSON.stringify(result, null, 2));
      }

      return text;
    } catch (error) {
      console.error(`[GeminiProvider] Error in getCompletion:`, error);
      console.error(`[GeminiProvider] Error type:`, typeof error);
      console.error(`[GeminiProvider] Error message:`, error.message);
      console.error(`[GeminiProvider] Error stack:`, error.stack);

      if (error instanceof Error) {
          throw new GeminiProviderException(error.message, error);
      }

      throw new GeminiProviderException(
          "Unknown error while communicating with Gemini",
      );
    }
  }

  getCapabilities() {
    return {
      id: "gemini",
      label: "Gemini",
      models: [this.#modelName],
    };
  }

  #buildPrompt(categories, destinationName, description) {
    const categoryList = categories.join(", ");
    return `You are an automated financial transaction classifier. Only respond with one of the provided categories. Categories: ${categoryList} Destination Name: "${destinationName}" Description: "${description}" Respond with the single category label that best matches the transaction.`;
  }

  #normaliseGuess(rawText) {
    if (!rawText) {
      return "";
    }

    return rawText.split("\n")[0].trim();
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
