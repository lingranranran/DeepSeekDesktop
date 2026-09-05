// DeepSeek Harness Desktop 桌面桥插件（M7.3）
//
// 由宿主以 `dsh web --patch <yml>` 覆盖层注入（见 electron/main.ts setupDesktopBridge），
// 把 dsh 内部事件转成 stdout 单行标记 `@@DSH_DESKTOP_EVENT@@ {json}`，
// 宿主 DshManager 逐行解析后发系统通知。
// 自包含、零依赖：只使用 cordis 上下文与 process.stdout。

export const name = 'dsh-desktop-bridge';

export function apply(ctx) {
  const emit = (type, payload) => {
    try {
      process.stdout.write(`@@DSH_DESKTOP_EVENT@@ ${JSON.stringify({ type, payload })}\n`);
    } catch {
      /* stdout 不可用时静默：桥接失败绝不影响 dsh 本体 */
    }
  };

  // 任务完成：仅 running → idle 的转换视为"一次任务结束"。
  // 首次见到某 agent 即为 idle（如 dsh 启动时）不打扰。
  const lastStatus = new Map();
  ctx.on(
    'agent/status',
    (payload) => {
      try {
        const id = typeof payload?.agent?.id === 'string' ? payload.agent.id : null;
        const status = payload?.status;
        if (!id) return;
        const prev = lastStatus.get(id);
        lastStatus.set(id, status);
        if (status === 'idle' && prev === 'running') emit('agent-idle', {});
      } catch {
        /* 状态跟踪失败不影响 dsh */
      }
    },
    { global: true } // 根作用域监听所有 agent 的事件（与 dsh-agent invariant 同款用法）
  );

  // 权限审批：waterfall 旁路监听，上报后必须 return next() 透传给真正的应答者，
  // 否则审批链断裂会被 dsh-user-approval 判为 fail-closed（unavailable）。
  ctx.on(
    'approval/request',
    (req, next) => {
      try {
        emit('approval-request', {
          toolName: typeof req?.toolName === 'string' ? req.toolName : '',
          reason: typeof req?.reason === 'string' ? req.reason : null,
          callId: typeof req?.callId === 'string' ? req.callId : null,
        });
      } catch {
        /* 桥接失败绝不阻断审批链 */
      }
      return next();
    },
    { global: true }
  );
}
