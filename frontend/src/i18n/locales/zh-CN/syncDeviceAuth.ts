export default {
    title: "设备需要认证",
    hint: "本机尚未完成同步认证。请使用已登录同一账号的微信小程序扫码，核对验证码后确认。",
    qrAlt: "设备认证二维码",
    verificationCode: "验证码",
    expire: "剩余 {time}",
    expired: "二维码已过期，请刷新",
    waiting: "等待小程序确认与主设备传钥…",
    loading: "正在生成认证二维码…",
    needRefresh: "请点击刷新重新获取二维码",
    refresh: "刷新二维码",
    later: "稍后",
    success: "设备认证成功，凭据将自动同步",
    successWithData:
      "设备认证成功，已同步连接 {connections} 个、数据库 {databases} 个",
    successNoCloudData:
      "设备认证成功，但云端暂无模块快照。请在仍有数据的设备上打开 OmniPanel 以回写云端，然后在本机点「立即拉取」。",
    pullFailed: "认证成功，但云端数据拉取失败，请稍后在设置中点「立即拉取」重试",
    timeout: "等待超时，请刷新二维码后重试",
  } as const;
