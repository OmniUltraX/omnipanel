/** Vite `define` 注入：OMNIPANEL_WEB=1 构建为 true。 */
declare const __OMNIPANEL_WEB__: boolean;

/** Docker entrypoint 运行时注入（见 deploy/docker/docker-entrypoint.sh）。 */
interface Window {
  __OMNIPANEL_API_KEY__?: string;
}
