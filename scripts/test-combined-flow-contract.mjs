import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCombinedFlowMessage,
  cleanupTrackedDataSources,
  commandContainsExactSqlLiteral,
  COMBINED_READ_SQL,
  executionMatchesExpectedSql,
  persistedCombinedExecCalls,
  requireReadyTrackedDataSource,
  sqlSha256,
} from "./lib/combined-flow-contract.mjs";

test("the combined-flow prompt delimits exact SQL without leaking expected answers", () => {
  const message = buildCombinedFlowMessage({
    connectorName: "forty-two-data-source",
    sessionId: "sess_TEST",
    fileDataSourceId: "ds_FILE",
    databaseDataSourceId: "ds_DATABASE",
    requestId: "00000000-0000-4000-8000-000000000001",
    nonce: "contract-nonce",
  });

  assert.ok(message.includes(`<sql>\n${COMBINED_READ_SQL}\n</sql>`));
  assert.equal(message.includes(`${COMBINED_READ_SQL}.`), false);
  assert.equal(message.includes(`${COMBINED_READ_SQL};`), false);
  assert.match(message, /Do not add quotes, a semicolon, a period/);
  assert.equal(message.includes("database=42"), false);
  assert.equal(message.includes("total=42"), false);
});

test("persisted-call proof accepts the exact SQL literal and rejects sentence punctuation", () => {
  const exactCommand = `sql = '${COMBINED_READ_SQL}'\ncall_tool('forty-two-data-source', 'get_file_download_url', requestHeaders=True, expectedETag=True)\ncall_tool('forty-two-data-source', 'run_read_query', sql=sql)`;
  const punctuatedCommand = `sql = '${COMBINED_READ_SQL}.'\ncall_tool('forty-two-data-source', 'get_file_download_url', requestHeaders=True, expectedETag=True)\ncall_tool('forty-two-data-source', 'run_read_query', sql=sql)`;
  const events = [exactCommand, punctuatedCommand].map((command, index) => ({
    type: "model.message",
    toolCalls: [
      {
        id: `call-${index}`,
        function: { name: "exec", arguments: JSON.stringify({ command }) },
      },
    ],
  }));

  const calls = persistedCombinedExecCalls(events, "forty-two-data-source");
  assert.deepEqual(
    calls.map((call) => call.id),
    ["call-0", "call-1"],
  );
  assert.equal(commandContainsExactSqlLiteral(calls[0].command), true);
  assert.equal(commandContainsExactSqlLiteral(calls[1].command), false);
});

test("authenticated execution evidence rejects an unused exact literal with a different executed query", () => {
  const wrongSql = "SELECT 42 AS value";
  const command = `expected = '${COMBINED_READ_SQL}'\nsql = '${wrongSql}'\ncall_tool('forty-two-data-source', 'get_file_download_url', requestHeaders=True, expectedETag=True)\ncall_tool('forty-two-data-source', 'run_read_query', sql=sql)`;
  const calls = persistedCombinedExecCalls(
    [
      {
        type: "model.message",
        toolCalls: [
          {
            id: "call-unused-literal",
            function: {
              name: "exec",
              arguments: JSON.stringify({ command }),
            },
          },
        ],
      },
    ],
    "forty-two-data-source",
  );

  assert.equal(commandContainsExactSqlLiteral(calls[0].command), true);
  assert.equal(
    executionMatchesExpectedSql({ executedSqlSha256: sqlSha256(wrongSql) }),
    false,
  );
});

test("authenticated execution evidence accepts the exact SQL hash", () => {
  const expectedHash =
    "0940fb1a0a04f5b9fba6b4b29c7c6349579181df5596faab79ec807f90cd3e6c";
  assert.equal(sqlSha256(), expectedHash);
  assert.equal(
    executionMatchesExpectedSql({ executedSqlSha256: expectedHash }),
    true,
  );
});

test("a failed 201 database registration runs finally cleanup", async () => {
  const dataSourceId = "ds_01M16JEAJH23FD5EFBBM33PH9F";
  const cleanupIds = new Set();
  const deleted = [];
  let cleanupErrors = [];

  try {
    assert.throws(
      () =>
        requireReadyTrackedDataSource(
          { id: dataSourceId, status: "failed" },
          cleanupIds,
        ),
      /returned status 'failed'/,
    );
  } finally {
    cleanupErrors = await cleanupTrackedDataSources(
      cleanupIds,
      async (trackedId) => deleted.push(trackedId),
    );
  }

  assert.deepEqual(cleanupErrors, []);
  assert.deepEqual(deleted, [dataSourceId]);
});
