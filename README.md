# Firefly III AI categorization

This project allows you to automatically categorize your expenses in [Firefly III](https://www.firefly-iii.org/) by
using configurable AI providers (OpenAI by default, Gemini and Synthetic.new supported out of the box).

## How it works

It provides a webhook that you can set up to be called every time a new expense is added.

It will then generate a prompt for the configured AI provider, including your existing categories, the recipient and the
description of the transaction.

The provider will, based on that prompt, guess the category for the transaction.

If it is one of your existing categories, the tool will set the category on the transaction and also add a tag to the
transaction.

If it cannot detect the category, it will not update anything.

## Privacy

Please note that some details of the transactions will be sent to the configured AI provider as information to guess the category.

These are:

- Transaction description
- Name of transaction destination account
- Names of all categories

## Installation

### 1. Get a Firefly Personal Access Token

You can generate your own Personal Access Token on the Profile page. Login to your Firefly III instance, go to
"Options" > "Profile" > "OAuth" and find "Personal Access Tokens". Create a new Personal Access Token by clicking on
"Create New Token". Give it a recognizable name and press "Create". The Personal Access Token is pretty long. Use a tool
like Notepad++ or Visual Studio Code to copy-and-paste it.

![Step 1](docs/img/pat1.png)
![Step 2](docs/img/pat2.png)
![Step 3](docs/img/pat3.png)

### 2. Get AI provider credentials

By default the app uses OpenAI. Follow the instructions for the provider you want to run and export the corresponding environment variables.

#### OpenAI (default)

The project needs to be configured with your OpenAI account's secret key.

- Sign up for an account by going to the OpenAI website (https://platform.openai.com)
- Once an account is created, visit the API keys page at https://platform.openai.com/account/api-keys.
- Create a new key by clicking the "Create new secret key" button.

When an API key is created you'll be able to copy the secret key and use it.

![OpenAI screenshot](docs/img/openai-key.png)

Note: OpenAI currently provides 5$ free credits for 3 months which is great since you won’t have to provide your
payment details to begin interacting with the API for the first time.

After that you have to enable billing in your account.

Tip: Make sure to set budget limits to prevent suprises at the end of the month.

Set `AI_PROVIDER=openai` (default) and `OPENAI_API_KEY` with the secret you generated.

#### Gemini

- Visit the Google AI developer site at https://ai.google.dev/ and open Google AI Studio.
- Create an API key at https://aistudio.google.com/app/apikey tied to the project that has Gemini access.
- Copy the key and set it as `GEMINI_API_KEY` in your environment.

Gemini models require an allowed billing project. You can optionally override the default model by exporting `GEMINI_MODEL` (defaults to `gemini-2.5-flash`). Remember to set `AI_PROVIDER=gemini` when using this integration.

#### Synthetic.new

Synthetic.new provides access to various AI models through an OpenAI-compatible API.

- Visit your Synthetic.new instance or provider to obtain an API key.
- Copy the API key and set it as `SYNTHETIC_API_KEY` in your environment.

Set `AI_PROVIDER=synthetic` when using this integration. You can optionally configure:
- `SYNTHETIC_BASE_URL`: The base URL of the Synthetic.new API (defaults to `https://synthetic.xdelloco.xyz`)
- `SYNTHETIC_MODEL`: The model to use (defaults to `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`)
- `SYNTHETIC_TEMPERATURE`: Sampling temperature from 0.0 to 2.0 (defaults to `0.7`)

### 3. Start the application via Docker

#### 3.1 Docker Compose

Create a new file `docker-compose.yml` with this content (or add to existing docker-compose file):

```yaml
version: '3.3'

services:
  categorizer:
    image: ghcr.io/bahuma20/firefly-iii-ai-categorize:latest
    restart: always
    ports:
      - "3000:3000"
    environment:
      FIREFLY_URL: "https://firefly.example.com"
      FIREFLY_PERSONAL_TOKEN: "eyabc123..."
      OPENAI_API_KEY: "sk-abc123..."
```

Make sure to set the environment variables correctly.

Run `docker-compose up -d`.

Now the application is running and accessible at port 3000.

#### 3.2 Manually via Docker

Run this Docker command to start the application container. Edit the environment variables to match the credentials
created before.

```shell
docker run -d \
-p 3000:3000 \
-e FIREFLY_URL=https://firefly.example.com \
-e FIREFLY_PERSONAL_TOKEN=eyabc123... \
-e OPENAI_API_KEY=sk-abc123... \
ghcr.io/bahuma20/firefly-iii-ai-categorize:latest
```

### 4. Set up the webhook

After starting your container, you have to set up the webhook in Firefly that will automatically trigger the
categorization everytime a new transaction comes in.

- Login to your Firefly instance
- In the sidebar go to "Automation" > "Webhooks"
- Click "Create new webhook"
- Give the webhook a title. For example "AI Categorizer"
- Set "Trigger" to "After transaction creation" (should be the default)
- Set "Response" to "Transaction details" (should be the default)
- Set "Delivery" to "JSON" (should be the default)
- Set "URL" to the URL where the application is reachable + "/webhook". For example if you are using docker-compose your
  URL could look like this: `http://categorizer:3000/webhook`
- Click "Submit"

![Step 1](docs/img/webhook1.png)
![Step 2](docs/img/webhook2.png)
![Step 3](docs/img/webhook3.png)

Now you are ready and every new withdrawal transaction should be automatically categorized by the configured AI provider.

## User Interface

The application comes with a minimal UI that allows you to monitor the classification queue and see the provider prompts
and responses. This UI is disabled by default.

To enable this UI set the environment variable `ENABLE_UI` to `true`.

After a restart of the application the UI can be accessed at `http://localhost:3000/` (or any other URL that allows you
to reach the container).

## Manual listing and classification

In addition to the webhook you can review and enqueue classifications manually. Set `FIREFLY_URL` and
`FIREFLY_PERSONAL_TOKEN` so the server can talk to your Firefly III instance.

### List transactions

The REST endpoint `/api/transactions` mirrors Firefly's pagination and returns a simplified view of every split in the
resulting journals. You can filter by `limit`, `page`, and `type` (defaults to `default`).

```shell
curl "http://localhost:3000/api/transactions?limit=10&page=1"
```

Sample response (truncated):

```json
{
  "items": [
    {
      "journalId": "10898",
      "id": "10898:0",
      "date": "2025-11-03T00:08:00+01:00",
      "type": "withdrawal",
      "description": "Transferencia inmediata...",
      "amount": "333.02",
      "currency": "EUR",
      "source_name": "Trade Republic",
      "destination_name": "Openbank",
      "category_id": null
    }
  ],
  "pagination": {
    "current": 1,
    "limit": 10,
    "pageCount": 2259,
    "next": "http://localhost/api/v1/transactions?limit=10&type=default&page=2"
  }
}
```

### Enqueue a manual classification

Once you decide to classify a journal, submit its ID to `/api/classify`. The server fetches the latest details, performs
the same validations as the webhook, and enqueues the job in the existing queue.

```shell
curl -X POST "http://localhost:3000/api/classify" \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"10898"}'
```

The endpoint replies with the queued job metadata (`202 Accepted`) so you can track progress via Socket.IO or the Jobs panel.

### Using the UI

When `ENABLE_UI=true`, the dashboard shows a new **Transacciones** section above the Jobs feed. Use the limit/page
controls to page through `/api/transactions`, review each split, and click **Clasificar** to trigger `/api/classify`.
Only uncategorized withdrawals expose the button; queued jobs then appear immediately in the Jobs list for real-time
tracking.

## Adjust Tag name

The application automatically sets the tag "AI categorized" on every transaction that was processed and a category could
be guessed.

You can configure the name of this tag by setting the environment variable `FIREFLY_TAG` accordingly.

## Running on a different port

If you have to run the application on a different port than the default port `3000` set the environment variable `PORT`.

## Full list of environment variables

- `FIREFLY_URL`: The URL to your Firefly III instance. Example: `https://firefly.example.com`. (required)
- `FIREFLY_PERSONAL_TOKEN`: A Firefly III Personal Access Token. (required)
- `AI_PROVIDER`: Selects which AI integration to run (`openai`, `gemini`, `synthetic`). (Default: `openai`)
- `OPENAI_API_KEY`: The OpenAI API Key to authenticate against OpenAI. (Required when `AI_PROVIDER=openai`)
- `GEMINI_API_KEY`: Google AI Studio API key for Gemini access. (Required when `AI_PROVIDER=gemini`)
- `GEMINI_MODEL`: Gemini model name to use. (Default: `gemini-2.5-flash`)
- `SYNTHETIC_API_KEY`: Synthetic.new API key for access. (Required when `AI_PROVIDER=synthetic`)
- `SYNTHETIC_BASE_URL`: The base URL of the Synthetic.new API. (Default: `https://synthetic.xdelloco.xyz`)
- `SYNTHETIC_MODEL`: Synthetic.new model name to use. (Default: `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`)
- `SYNTHETIC_TEMPERATURE`: Sampling temperature for Synthetic.new (0.0-2.0). (Default: `0.7`)
- `ENABLE_UI`: If the user interface should be enabled. (Default: `false`)
- `FIREFLY_TAG`: The tag to assign to the processed transactions. (Default: `AI categorized`)
- `PORT`: The port where the application listens. (Default: `3000`)
