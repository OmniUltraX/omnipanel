/**
 * 副作用入口：拉起 modules 侧对 lib/*Bridge 的 hook 注册。
 *
 * stores 不再静态 import modules/assistant|clientSync 后，若不在启动路径显式拉起，
 * notify/cancel/inbox 会一直 pending 或 no-op。本文件只做 side-effect import。
 */
import "../modules/assistant/autoSync";
import "../modules/assistant/chatInbox";
import "../modules/assistant/terminalCmdInbox";
import "../modules/clientSync/autoSync";
import "../modules/clientSync/moduleSync";
