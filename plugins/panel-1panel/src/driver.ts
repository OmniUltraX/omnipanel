import { createOnePanelClient } from "../../../frontend/src/lib/onepanel";
import {
  asRecordList,
  normalizePanelDatabaseRow,
  type PanelConnectionCtx,
  type PanelCreateDatabaseInput,
  type PanelDeleteDatabaseInput,
  type PanelDriver,
} from "../../../frontend/src/lib/panelDriverRegistry";

function clientOf(ctx: PanelConnectionCtx) {
  return createOnePanelClient(ctx.address, ctx.apiKey, ctx.connectionId);
}

export const onePanelDriver: PanelDriver = {
  async testConnection(ctx) {
    return clientOf(ctx).testConnection();
  },
  async listDatabases(ctx) {
    const items = await clientOf(ctx).searchDatabases();
    return asRecordList(items).map((row) => normalizePanelDatabaseRow(row));
  },
  async createDatabase(ctx: PanelConnectionCtx, input: PanelCreateDatabaseInput) {
    await clientOf(ctx).createDatabase({
      name: input.name,
      username: input.dbUser,
      password: input.password,
      permission: input.address || "127.0.0.1",
      format: input.charset || "utf8mb4",
      description: input.remark ?? "",
    });
  },
  async deleteDatabase(ctx: PanelConnectionCtx, input: PanelDeleteDatabaseInput) {
    await clientOf(ctx).deleteDatabase({
      id: input.id,
      name: input.name,
      type: input.type,
    });
  },
};
