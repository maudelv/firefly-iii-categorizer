import { Configuration, OpenAIApi } from "openai";
import Provider from "./Provider.js";
import { getConfigVariable } from "../util.js";

export default class OpenAiProvider extends Provider {
  #openAi;
  #model;
  #defaultOptions = {};

  constructor() {
    super();

    const apiKey = getConfigVariable("OPENAI_API_KEY");

    const configuration = new Configuration({ apiKey });
    this.#openAi = new OpenAIApi(configuration);

    this.#model = getConfigVariable("OPENAI_MODEL", "gpt-3.5-turbo-instruct");
    this.#defaultOptions = {
      temperature: parseFloat(getConfigVariable("OPENAI_TEMPERATURE", "0.7")),
      max_tokens: parseInt(getConfigVariable("OPENAI_MAX_TOKENS", "2048"), 10),
    };
  }

  /**
   * Classifies a transaction using OpenAI's completion API.
   * @param {Object} options - The classification options
   * @param {string[]} options.categories - Array of valid category names to classify into
   * @param {string} options.destinationName - Name of the transaction destination/recipient
   * @param {string} options.description - Transaction description or subject line
   * @param {Object} [options.modelOptions={}] - OpenAI model options (temperature, max_tokens, etc.)
   * @param {number} [options.modelOptions.temperature] - Sampling temperature (0.0-2.0)
   * @param {number} [options.modelOptions.max_tokens] - Maximum tokens to generate
   * @returns {Promise<Object|null>} Promise resolving to classification result or null if classification failed
   * @returns {string} returns.prompt - The exact prompt sent to OpenAI
   * @returns {string} returns.response - Raw response text from OpenAI
   * @returns {string} returns.category - The chosen category (must be in options.categories)
   * @throws {OpenAiException} When OpenAI API call fails (network error, invalid API key, etc.)
   * @throws {OpenAiException} When OpenAI API response contains an error
   */

  async classify({
    categories,
    destinationName,
    description,
    modelOptions = {},
  }) {
    // eslint-disable-line no-unused-vars
    try {
      const prompt = this.#generatePrompt(
        categories,
        destinationName,
        description,
      );

      const options = {
        model: this.#model,
        prompt,
        ...this.#defaultOptions,
        ...modelOptions,
      };

      const response = await this.#openAi.createCompletion(options);

      let guess = response.data.choices[0].text;
      guess = guess.replace("\n", "");
      guess = guess.trim();

      if (categories.indexOf(guess) === -1) {
        console.warn(`OpenAI could not classify the transaction.
          Prompt: ${prompt}
          OpenAIs guess: ${guess}`);
        return null;
      }
      return {
        prompt,
        response: response.data.choices[0].text,
        category: guess,
      };
    } catch (error) {
      if (error.response) {
        console.error(error.response.status);
        console.error(error.response.data);
        throw new OpenAiException(
          error.status,
          error.response,
          error.response.data,
        );
      } else {
        console.error(error.message);
        throw new OpenAiException(null, null, error.message);
      }
    }
  }

  /**
   * Gets a text completion from OpenAI's API.
   * @param {string} prompt - The text prompt to send to OpenAI for completion
   * @param {Object} [modelOptions={}] - Additional OpenAI model options to override defaults
   * @param {number} [modelOptions.temperature] - Sampling temperature (0.0-2.0), overrides default
   * @param {number} [modelOptions.max_tokens] - Maximum tokens to generate, overrides default
   * @returns {Promise<string>} Promise resolving to the completed text from OpenAI
   * @throws {OpenAiException} When OpenAI API call fails or returns an error
   */

  async getCompletion(prompt, modelOptions = {}) {
    try {
      const options = {
        model: this.#model,
        prompt,
        ...this.#defaultOptions,
        ...modelOptions,
      };

      const response = await this.#openAi.createCompletion(options);

      let text = response.data.choices[0].text;
      text = text.replace("\n", "");
      text = text.trim();

      return text;
    } catch (error) {
      if (error.response) {
        console.error(error.response.status);
        console.error(error.response.data);
        throw new OpenAiException(
          error.status,
          error.response,
          error.response.data,
        );
      } else {
        console.error(error.message);
        throw new OpenAiException(null, null, error.message);
      }
    }
  }

  getCapabilities() {
    return {
      id: "openai",
      label: "OpenAI",
      models: [this.#model],
    };
  }

  #generatePrompt(categories, destinationName, description) {
    return `Given I want to categorize transactions on my bank account into this categories: ${categories.join(", ")}
In which category would a transaction from "${destinationName}" with the subject "${description}" fall into?
Just output the name of the category. Does not have to be a complete sentence.`;
  }
}

class OpenAiException extends Error {
  code;
  response;
  body;

  constructor(statusCode, response, body) {
    super(`Error while communicating with OpenAI: ${statusCode} - ${body}`);
    this.code = statusCode;
    this.response = response;
    this.body = body;
  }
}
