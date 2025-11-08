import { getConfigVariable } from "./util.js";

const CONFIG = {
  AUTOCOMPLETE_LIMIT: getConfigVariable("EXPENSE_ACCOUNT_AUTOCOMPLETE_LIMIT", 15),
  AI_TEMPERATURE: getConfigVariable("EXPENSE_ACCOUNT_AI_TEMPERATURE", 0.2)
}

const DEFAULT_AUTOCOMPLETE_LIMIT = 15;
const PLACEHOLDER_VALUES = new Set([
    "",
    "no name",
    "sin nombre",
    "unknown",
    "desconocido",
]);

const GENERIC_PHRASES = [
  "google pay",
  "apple pay",
  "compra en",
  "compras en",
  "con la tarjeta",
  "tarjeta",
]

const STOP_WORDS = new Set([
  "con",
  "en",
  "por",
  "para",
  "una",
  "un",
  "y",
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "al",
  "compra",
  "compras",
  "tarjeta",
  "banco",
  "pago",
  "google",
  "pay",
  "apple",
])

export default class ExpenseAccountMatcher {
    #provider;
    #firefly;
    #autocompleteLimit;

    constructor(provider, fireflyService, options = {}) {
        if (!provider) {
            throw new Error("ExpenseAccountMatcher requires an AI provider instance");
        }

        this.#provider = provider;
        this.#firefly = fireflyService;
        this.#autocompleteLimit = options.autocompleteLimit ?? DEFAULT_AUTOCOMPLETE_LIMIT;
    }

    #isPlaceholder(text) {
        if (text == null) {
            return true;
        }

        const normalized = String(text)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim();

        if (normalized.length === 0) {
            return true;
        }

        const stripped = normalized
            .replace(/[()\[\]{}]/g, "")
            .replace(/"/g, "")
            .replace(/'+/g, "")
            .replace(/\s+/g, " ")
            .trim();

        return stripped.length === 0 || PLACEHOLDER_VALUES.has(stripped);
    }

    async matchTransaction(transaction) {
        if (!transaction || !transaction.description) {
            throw new Error("Transaction with description is required");
        }

        const descriptionInfo = this.#normalizeText(transaction.description);
        const destinationInfo = this.#normalizeText(transaction.destination_name ?? "");

        const queries = this.#generateQueries(transaction, descriptionInfo, destinationInfo);
        const autocompleteCandidates = await this.#collectAutocompleteCandidates(queries);

        const deterministicMatch = this.#attemptDeterministicMatch(
            autocompleteCandidates,
            descriptionInfo.tokens,
            destinationInfo.tokens
        );

        if (deterministicMatch) {
            const decision = {
                decision: "existing",
                account: {
                    id: deterministicMatch.id,
                    name: deterministicMatch.name,
                    description: deterministicMatch.description ?? "",
                    source: "autocomplete",
                },
            };

            return decision;
        }

        // If no candidates found, use AI to generate a new account name
        if (autocompleteCandidates.length === 0) {
            return await this.#createNewAccountWithAi(transaction);
        }

        // If we have candidates but deterministic matching failed,
        // pick the first candidate (best available option)
        const firstCandidate = autocompleteCandidates.find(c => !this.#isPlaceholder(c?.name));
        if (firstCandidate) {
            console.debug(`[ExpenseAccountMatcher] Deterministic matching failed, using first candidate: ${firstCandidate.name}`);
            return {
                decision: "existing",
                account: {
                    id: firstCandidate.id,
                    name: firstCandidate.name,
                    description: firstCandidate.description ?? "",
                    source: "autocomplete-fallback",
                },
            };
        }

        // Fallback to creating new account
        return await this.#createNewAccountWithAi(transaction);
    }

    async #createNewAccountWithAi(transaction) {
        const prompt = `You are categorizing a financial transaction. Your primary goal is to create SPECIFIC expense accounts using the actual merchant/brand/store name rather than generic categories.

        TRANSACTION DATA:
        - Description: "${transaction.description}"
        - Merchant/Location: ${transaction.destination_name || 'Not specified'}

        RULES FOR ACCOUNT NAMING:
        1. ALWAYS prefer the actual merchant/brand name over generic categories
        2. Use the exact business name if available and recognizable
        3. Only use generic names when the merchant is unclear or truly generic (like "ATM Withdrawal")
        4. Keep names concise but descriptive (2-4 words ideally)

        EXAMPLES:
        GOOD (specific): "Starbucks Coffee", "Shell Gas Station", "Amazon Purchase", "Walmart Groceries"
        BAD (generic): "Coffee Shop", "Gas Station", "Online Shopping", "Grocery Store"

        TASK:
        Analyze the transaction and create an expense account. Respond with JSON only:

        {"decision": "create", "account": {"name": "specific_merchant_name", "description": "brief_description_of_what_this_account_covers"}}`;

        const modelOptions = {
            temperature: 0.2,
            max_tokens: 2048,
        };

        console.debug(`[ExpenseAccountMatcher] Creating new account with AI. Transaction: ${transaction.description}`);

        const responseText = await this.#provider.getCompletion(prompt, modelOptions);

        // Extract JSON from markdown response
        let parsedResponse;
        try {
            // Remove markdown formatting if present
            const jsonText = responseText.replace(/```json\n?|\n?```/g, '').trim();
            parsedResponse = JSON.parse(jsonText);
        } catch (error) {
            console.error(`[ExpenseAccountMatcher] Failed to parse AI response: ${error.message}`);
            console.error(`[ExpenseAccountMatcher] Raw response: ${responseText}`);
            throw new Error("AI failed to generate a valid new account structure");
        }

        // Ensure AI response has correct structure
        if (parsedResponse.decision !== "create" || !parsedResponse.account?.name) {
            throw new Error("AI failed to generate a valid new account structure");
        }

        parsedResponse.account.description = parsedResponse.account.description ?? "";
        parsedResponse.account.source = "ai-new";

        return parsedResponse;
    }

    #normalizeText(input) {
        if (!input || typeof input !== "string") {
            return {
                normalizedText: "",
                tokens: [],
            };
        }

        if (this.#isPlaceholder(input)) {
            return {
                normalizedText: "",
                tokens: [],
            };
        }

        const base = input
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase();

        const withoutDates = base.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
        const withoutLongDigits = withoutDates.replace(/\b\d{4,}\b/g, " ");

        let simplified = withoutLongDigits;

        GENERIC_PHRASES.forEach(phrase => {
            const pattern = new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "g");
            simplified = simplified.replace(pattern, " ");
        });

        simplified = simplified.replace(/[^a-z\s]/g, " ");

        const tokens = simplified
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => token.length > 1 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));

        const uniqueTokens = Array.from(new Set(tokens));

        return {
            normalizedText: uniqueTokens.join(" "),
            tokens: uniqueTokens,
        };
    }

    #generateQueries(transaction, descriptionInfo, destinationInfo) {
        const queries = new Set();

        if (transaction.destination_name && !this.#isPlaceholder(transaction.destination_name)) {
            queries.add(transaction.destination_name.trim());
        }

        if (destinationInfo.normalizedText) {
            queries.add(destinationInfo.normalizedText);
        }

        if (descriptionInfo.normalizedText) {
            queries.add(descriptionInfo.normalizedText);
        }

        if (descriptionInfo.tokens.length >= 3) {
            queries.add(descriptionInfo.tokens.slice(0, 3).join(" "));
        }

        if (descriptionInfo.tokens.length >= 2) {
            queries.add(descriptionInfo.tokens.slice(0, 2).join(" "));
        }

        descriptionInfo.tokens.forEach(token => {
            if (token.length > 3) {
                queries.add(token);
            }
        });

        if (destinationInfo.tokens.length) {
            destinationInfo.tokens.forEach(token => {
                if (token.length > 3) {
                    queries.add(token);
                }
            });
        }

        return Array.from(queries)
            .map(query => query.trim())
            .filter(query => query.length > 0);
    }

    async #collectAutocompleteCandidates(queries) {
        if (!this.#firefly || !Array.isArray(queries) || queries.length === 0) {
            return [];
        }

        for (const query of queries) {
            if (this.#isPlaceholder(query)) {
                continue;
            }
            try {
                const suggestions = await this.#firefly.getExpenseAccountSuggestions(query, this.#autocompleteLimit);
                const filteredSuggestions = suggestions.filter(candidate => !this.#isPlaceholder(candidate?.name));

                if (filteredSuggestions.length > 0) {
                    console.debug(`[ExpenseAccountMatcher] Autocomplete matched '${query}' with ${filteredSuggestions.length} candidate(s)`);
                    return filteredSuggestions;
                }
            } catch (error) {
                console.error(`[ExpenseAccountMatcher] Autocomplete failed for '${query}': ${error.message}`);
            }
        }

        return [];
    }

    #attemptDeterministicMatch(candidates, descriptionTokens, destinationTokens) {
        if (!Array.isArray(candidates) || candidates.length === 0) {
            return null;
        }

        if (candidates.length === 1) {
            if (this.#isPlaceholder(candidates[0]?.name)) {
                return null;
            }
            return candidates[0];
        }

        const targetTokens = new Set([...descriptionTokens, ...destinationTokens]);
        console.debug(`[ExpenseAccountMatcher] Target tokens: [${[...targetTokens].join(', ')}]`);

        const minimumMatches = targetTokens.size > 10
            ? Math.max(1, Math.floor(targetTokens.size / 4))
            : Math.max(1, Math.ceil(targetTokens.size / 2));

        console.debug(`[ExpenseAccountMatcher] Minimum matches required: ${minimumMatches}`);

        let bestMatch = null;
        let bestMatchCount = 0;

        for (const candidate of candidates) {
            if (!candidate?.name) {
                continue;
            }

            const normalizedCandidate = this.#normalizeText(candidate.name);
            const candidateTokens = new Set(normalizedCandidate.tokens);

            const matches = [...targetTokens].filter(token => candidateTokens.has(token)).length;

            if (matches > bestMatchCount) {
                bestMatch = candidate;
                bestMatchCount = matches;
            }

            if (matches >= minimumMatches) {
                return candidate;
            }
        }

        // If no candidate meets threshold but we found a partial match, use the best one
        return bestMatchCount > 0 ? bestMatch : null;
    }
}
