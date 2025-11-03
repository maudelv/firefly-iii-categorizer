import { GoogleGenerativeAI } from "@google/generative-ai";
import Provider from "./Provider.js";
import { getConfigVariable } from "../util.js";

export default class GeminiProvider extends Provider {
  #model;
  #modelName;

  constructor() {
    super();

    const apiKey = getConfigVariable("GEMINI_API_KEY");
    this.#modelName = getConfigVariable("GEMINI_MODEL", "gemini-2.5-flash");

    const client = new GoogleGenerativeAI(apiKey);
    this.#model = client.getGenerativeModel({ model: this.#modelName });
  }

  async classify({ categories, destinationName, description, metadata = {} }) {
    // eslint-disable-line no-unused-vars
    try {
      const prompt = this.#buildPrompt(
        categories,
        destinationName,
        description,
      );
      const response = await this.#model.generateContent(prompt);
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

  getCapabilities() {
    return {
      id: "gemini",
      label: "Gemini",
      models: [this.#modelName],
    };
  }

  #buildPrompt(categories, destinationName, description) {
    const categoryList = categories.join(", ");
    return `You are an automated financial transaction classifier.
Only respond with one of the provided categories.
Categories: ${categoryList}
Destination Name: "${destinationName}"
Description: "${description}"
Respond with the single category label that best matches the transaction.`;
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
