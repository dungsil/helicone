import { RateLimitStore } from "../lib/stores/RateLimitStore";
import { RateLimitHandler } from "../lib/handlers/RateLimitHandler";
import { AuthenticationHandler } from "../lib/handlers/AuthenticationHandler";
import { RequestBodyHandler } from "../lib/handlers/RequestBodyHandler";
import { LoggingHandler } from "../lib/handlers/LoggingHandler";
import { ResponseBodyHandler } from "../lib/handlers/ResponseBodyHandler";
import { HandlerContext, Message } from "../lib/handlers/HandlerContext";
import { LogStore } from "../lib/stores/LogStore";
import { RequestResponseStore } from "../lib/stores/RequestResponseStore";
import { ClickhouseClientWrapper } from "../lib/db/ClickhouseWrapper";
import { PromptHandler } from "../lib/handlers/PromptHandler";
import { PosthogClient, postHogClient } from "../lib/clients/postHogClient";
import { PostHogHandler } from "../lib/handlers/PostHogHandler";
import { S3Client } from "../lib/shared/db/s3Client";
import { S3ReaderHandler } from "../lib/handlers/S3ReaderHandler";

export class LogManager {
  public async processLogEntries(
    logMessages: Message[],
    batchId: string
  ): Promise<void> {
    const clickhouseClientWrapper = new ClickhouseClientWrapper({
      CLICKHOUSE_HOST: process.env.CLICKHOUSE_HOST ?? "http://localhost:18123",
      CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? "default",
      CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? "",
    });

    const authHandler = new AuthenticationHandler();
    const rateLimitHandler = new RateLimitHandler(
      new RateLimitStore(clickhouseClientWrapper)
    );
    const s3Reader = new S3ReaderHandler(
      new S3Client(
        process.env.S3_ACCESS_KEY ?? "",
        process.env.S3_SECRET_KEY ?? "",
        process.env.S3_ENDPOINT ?? "",
        process.env.S3_BUCKET_NAME ?? ""
      )
    );
    const requestHandler = new RequestBodyHandler();
    const responseBodyHandler = new ResponseBodyHandler();
    const promptHandler = new PromptHandler();
    const loggingHandler = new LoggingHandler(
      new LogStore(),
      new RequestResponseStore(clickhouseClientWrapper)
    );
    const posthogHandler = new PostHogHandler(new PosthogClient(postHogClient));

    authHandler
      .setNext(rateLimitHandler)
      .setNext(s3Reader)
      .setNext(requestHandler)
      .setNext(responseBodyHandler)
      .setNext(promptHandler)
      .setNext(loggingHandler)
      .setNext(posthogHandler);

    await Promise.all(
      logMessages.map(async (logMessage) => {
        const handlerContext = new HandlerContext(logMessage);
        await authHandler.handle(handlerContext);
      })
    );

    console.log(`Finished processing batch ${batchId}`);
    // Inserts everything in transaction
    const upsertResult = await loggingHandler.handleResults();

    if (upsertResult.error) {
      console.error(
        `Error inserting logs: ${upsertResult.error} for batch ${batchId}`
      );
    }

    // Insert rate limit entries after logs
    const { data: rateLimitInsId, error: rateLimitErr } =
      await rateLimitHandler.handleResults();

    if (rateLimitErr || !rateLimitInsId) {
      console.error(
        `Error inserting rate limits: ${rateLimitErr} for batch ${batchId}`
      );
    }
  }
}
