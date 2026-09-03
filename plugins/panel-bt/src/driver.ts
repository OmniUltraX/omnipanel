import { createBtPanelClient } from "../../../frontend/src/lib/btpanel";
import {
  asRecordList,
  normalizePanelDatabaseRow,
  type PanelConnectionCtx,
  type PanelCreateDatabaseInput,
  type PanelDeleteDatabaseInput,
  type PanelDriver,
} from "../../../frontend/src/lib/panelDriverRegistry";

function clientOf(ctx: PanelConnectionCtx) {
  return createBtPanelClient(ctx.address, ctx.apiKey, ctx.connectionId);
}

export const btPanelDriver: PanelDriver = {
  async testConnection(ctx) {
    return clientOf(ctx).testConnection();
  },
  async listDatabases(ctx) {
    const result = await clientOf(ctx).getDatabaseList({ limit: 100 });
    return asRecordList(result.data).map((row) => normalizePanelDatabaseRow(row));
  },
  async createDatabase(ctx: PanelConnectionCtx, input: PanelCreateDatabaseInput) {
    await clientOf(ctx).addDatabase({
      name: input.name,
      dbUser: input.dbUser,
      password: input.password,
      address: input.address || "127.0.0.1",
      codeing: input.charset || "utf8mb4",
      ps: input.remark ?? "",
    });
  },
  async deleteDatabase(ctx: PanelConnectionCtx, input: PanelDeleteDatabaseInput) {
    await clientOf(ctx).deleteDatabase({
      id: input.id,
      name: input.name,
      dbUser: input.dbUser,
    });
  },
};
