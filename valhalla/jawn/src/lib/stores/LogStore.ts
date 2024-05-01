import { BatchPayload } from "../handlers/LoggingHandler";
import { deepCompare } from "../../utils/helpers";
import pgPromise from "pg-promise";
import { PromptRecord } from "../handlers/HandlerContext";
import { PromiseGenericResult, ok, err } from "../shared/result";
import { dbPromise as db, pgp } from "../shared/db/dbPromise";

const requestColumns = new pgp.helpers.ColumnSet(
  [
    "auth_hash",
    "body",
    "created_at",
    "formatted_prompt_id",
    "helicone_api_key_id",
    "helicone_org_id",
    "helicone_proxy_key_id",
    "helicone_user",
    { name: "id", cdn: true },
    "model",
    "model_override",
    "path",
    "prompt_id",
    "prompt_values",
    "properties",
    "provider",
    "request_ip",
    "target_url",
    "threat",
    "user_id",
  ],
  { table: "request" }
);
const onConflictRequest =
  " ON CONFLICT (id) DO UPDATE SET " +
  requestColumns.assignColumns({ from: "EXCLUDED", skip: "id" });

const responseColumns = new pgp.helpers.ColumnSet(
  [
    "body",
    "completion_tokens",
    "created_at",
    "delay_ms",
    "feedback",
    { name: "id", cdn: true },
    "model",
    "prompt_tokens",
    "request",
    "status",
    "time_to_first_token",
  ],
  { table: "response" }
);
const onConflictResponse =
  " ON CONFLICT (id) DO UPDATE SET " +
  responseColumns.assignColumns({ from: "EXCLUDED", skip: "id" });

const propertiesColumns = new pgp.helpers.ColumnSet(
  [
    "auth_hash",
    "created_at",
    { name: "id", cdn: true },
    ,
    "key",
    "request_id",
    "user_id",
    "value",
  ],
  { table: "properties" }
);
const onConflictProperties =
  " ON CONFLICT (id) DO UPDATE SET " +
  propertiesColumns.assignColumns({ from: "EXCLUDED", skip: "id" });

export class LogStore {
  constructor() {}

  async insertLogBatch(payload: BatchPayload): PromiseGenericResult<string> {
    try {
      await db.tx(async (t: pgPromise.ITask<{}>) => {
        // Insert into the 'request' table
        if (payload.requests && payload.requests.length > 0) {
          const insertRequest =
            pgp.helpers.insert(payload.requests, requestColumns) +
            onConflictRequest;
          await t.none(insertRequest);
        }

        // Insert into the 'response' table with conflict resolution
        if (payload.responses && payload.responses.length > 0) {
          const insertResponse =
            pgp.helpers.insert(payload.responses, responseColumns) +
            onConflictResponse;
          await t.none(insertResponse);
        }

        // Insert into the 'properties' table with conflict resolution
        if (payload.properties && payload.properties.length > 0) {
          const insertProperties =
            pgp.helpers.insert(payload.properties, propertiesColumns) +
            onConflictProperties;
          await t.none(insertProperties);
        }

        payload.prompts.sort((a, b) => {
          if (a.createdAt && b.createdAt) {
            if (a.createdAt < b.createdAt) {
              return -1;
            }
            if (a.createdAt > b.createdAt) {
              return 1;
            }
          }
          return 0;
        });

        for (const promptRecord of payload.prompts) {
          // acquire an exclusive lock on the prompt record for the duration of the transaction
          await t.none("SELECT pg_advisory_xact_lock($1)", [
            [promptRecord.promptId],
          ]);
          await this.processPrompt(promptRecord, t);
        }
      });

      return ok("Successfully inserted log batch");
    } catch (error: any) {
      console.error("Failed to insert log batch", error);
      return err("Failed to insert log batch");
    }
  }

  async processPrompt(
    newPromptRecord: PromptRecord,
    t: pgPromise.ITask<{}>
  ): PromiseGenericResult<string> {
    const { promptId, orgId, requestId, heliconeTemplate, model } =
      newPromptRecord;

    if (!heliconeTemplate) {
      return ok("No Helicone template to process");
    }

    // Ensure the prompt exists or create it, and lock the row
    let existingPrompt = await t.oneOrNone<{
      id: string;
    }>(
      `SELECT id FROM prompt_v2 WHERE organization = $1 AND user_defined_id = $2`,
      [orgId, promptId]
    );
    if (!existingPrompt) {
      existingPrompt = await t.one<{
        id: string;
      }>(
        `INSERT INTO prompt_v2 (user_defined_id, organization, created_at) VALUES ($1, $2, $3) RETURNING id`,
        [promptId, orgId, newPromptRecord.createdAt]
      );
    }

    // Check the latest version and decide whether to update
    const existingPromptVersion = await t.oneOrNone<{
      id: string;
      major_version: number;
      helicone_template: any;
      created_at: Date;
    }>(
      `SELECT id, major_version, helicone_template, created_at FROM prompts_versions 
       WHERE organization = $1 AND prompt_v2 = $2 ORDER BY major_version DESC LIMIT 1`,
      [orgId, existingPrompt.id]
    );

    let versionId = existingPromptVersion?.id ?? "";

    // Check if an update is necessary based on template comparison
    if (
      !existingPromptVersion ||
      (existingPromptVersion &&
        existingPromptVersion.created_at <= newPromptRecord.createdAt &&
        !deepCompare(existingPromptVersion.helicone_template, heliconeTemplate))
    ) {
      // Create a new version if the template has changed
      let majorVersion = existingPromptVersion
        ? existingPromptVersion.major_version + 1
        : 0;
      const newVersionResult = await t.one(
        `INSERT INTO prompts_versions (prompt_v2, organization, major_version, minor_version, helicone_template, model, created_at)
         VALUES ($1, $2, $3, 0, $4, $5, $6) RETURNING id`,
        [
          existingPrompt.id,
          orgId,
          majorVersion,
          heliconeTemplate,
          model,
          newPromptRecord.createdAt,
        ]
      );
      versionId = newVersionResult.id;
    }

    // Insert or update prompt input keys if there's a new version or no existing version
    if (versionId) {
      await t.none(
        `INSERT INTO prompt_input_keys (key, prompt_version, created_at)
         SELECT unnest($1::text[]), $2
         FROM unnest($1::text[]), unnest($3::timestamp[])
         ON CONFLICT (key, prompt_version) DO NOTHING`,
        [
          Object.keys(heliconeTemplate.inputs),
          versionId,
          newPromptRecord.createdAt,
        ]
      );

      // Record the inputs and source request
      await t.none(
        `INSERT INTO prompt_input_record (inputs, source_request, prompt_version, created_at)
         VALUES ($1, $2, $3, $4)`,
        [
          JSON.stringify(heliconeTemplate.inputs),
          requestId,
          versionId,
          newPromptRecord.createdAt,
        ]
      );
    }

    return ok("Prompt processed successfully");
  }
}
