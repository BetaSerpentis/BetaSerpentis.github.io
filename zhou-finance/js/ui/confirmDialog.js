// 周家财务 — 通用确认弹窗

let dialogCallback = null;

/**
 * 显示确认弹窗
 * @param {string} message - 提示文字
 * @param {Object} options - { confirmText, cancelText, danger }
 * @returns {Promise<boolean>}
 */
export function confirm(message, options = {}) {
  const {
    confirmText = '确认',
    cancelText = '取消',
    danger = false
  } = options;

  const overlay = document.getElementById('confirm-dialog');
  const messageEl = document.getElementById('confirm-message');
  const cancelBtn = document.getElementById('confirm-cancel');
  const okBtn = document.getElementById('confirm-ok');

  messageEl.textContent = message;
  cancelBtn.textContent = cancelText;
  okBtn.textContent = confirmText;

  if (danger) {
    okBtn.classList.add('danger');
  } else {
    okBtn.classList.remove('danger');
  }

  overlay.classList.remove('hidden');

  return new Promise((resolve) => {
    const cleanup = (result) => {
      overlay.classList.add('hidden');
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onConfirm);
      dialogCallback = null;
      resolve(result);
    };

    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);

    // 防止重复绑定
    if (dialogCallback) {
      cancelBtn.removeEventListener('click', dialogCallback.cancel);
      okBtn.removeEventListener('click', dialogCallback.confirm);
    }

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onConfirm);

    dialogCallback = { cancel: onCancel, confirm: onConfirm };

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    }, { once: true });
  });
}

/**
 * 显示提示弹窗（仅确认按钮）
 * @param {string} message
 * @returns {Promise<void>}
 */
export function alert(message) {
  return confirm(message, { confirmText: '知道了', cancelText: '' });
}

/**
 * 显示 Toast 消息
 * @param {string} message
 * @param {number} duration - 毫秒
 */
export function toast(message, duration = 1500) {
  const el = document.getElementById('success-toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
  }, duration);
}
