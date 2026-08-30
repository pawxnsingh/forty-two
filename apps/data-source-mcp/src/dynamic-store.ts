import {
  getReadyDatabaseDataSourceConnection,
  getTestingDatabaseDataSourceConnection,
  listReadyDatabaseDataSources,
} from "@forty-two/db";

import type { DynamicConnectionStore } from "./connection-registry.js";

export function createDynamicConnectionStore(): DynamicConnectionStore {
  return {
    listReady: listReadyDatabaseDataSources,
    getReady: (dataSourceId) =>
      getReadyDatabaseDataSourceConnection(dataSourceId),
    getTesting: (dataSourceId) =>
      getTestingDatabaseDataSourceConnection(dataSourceId),
  };
}
