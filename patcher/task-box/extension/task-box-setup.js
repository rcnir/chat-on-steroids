(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  let available = false;
  let recovery = null;
  let busy = false;
  function paintButton() {
    byId('enable').disabled = busy || recovery !== null || !available || !byId('oldDisabled').checked || !byId('reviewed').checked;
    byId('recover').disabled = busy || recovery === null || !byId('recoveryReviewed').checked || !byId('manualDeleted').checked;
  }
  async function refresh() {
    try {
      const state = await chrome.runtime.sendMessage({type:'clf-task-box-setup:status'});
      recovery = state?.ok === true && state.recoveryRequired === true && typeof state.recoveryRequestId === 'string' &&
        Number.isInteger(state.recoveryGeneration) ? {requestId:state.recoveryRequestId,generation:state.recoveryGeneration} : null;
      byId('cutover').hidden = recovery !== null;
      byId('recovery').hidden = recovery === null;
      available = recovery === null && state?.ok === true && state.available === true && state.enabled !== true;
      byId('status').textContent = recovery ?
        '完了済みClearのbrowser lifecycleが残っています。TASK BOX Projectを手動削除済みの場合だけ、下の専用復旧を実行できます。' :
        state?.enabled && state?.available ? '統合版は有効です。TASK BOXページを一度読み込み直してください。' :
        state?.enabled ? '設定は有効ですが、現在は対応アプリへの接続を確認できません。BOX CLEARは押さないでください。' :
        available ? '対応アプリへの接続を確認しました。切替前の2点を確認してください。' :
        `まだ有効化できません：${state?.error || '対応するアプリが未反映です。'}`;
    } catch {
      byId('status').textContent='拡張との接続が切れました。この設定ページを読み込み直してください。';
      available=false;recovery=null;byId('cutover').hidden=false;byId('recovery').hidden=true;
    }
    paintButton();
  }
  byId('oldDisabled').addEventListener('change',paintButton);
  byId('reviewed').addEventListener('change',paintButton);
  byId('recoveryReviewed').addEventListener('change',paintButton);
  byId('manualDeleted').addEventListener('change',paintButton);
  byId('enable').addEventListener('click',async () => {
    if (byId('enable').disabled) return;
    busy=true;paintButton();
    try {
      const reply=await chrome.runtime.sendMessage({type:'clf-task-box-setup:enable',oldExtensionDisabled:byId('oldDisabled').checked,
        previousOutcomeReviewed:byId('reviewed').checked});
      if (!reply?.ok) { byId('status').textContent=`切替を停止しました：${reply?.error || '不明な結果'}`;available=false; }
      else await refresh();
    } catch { byId('status').textContent='応答を確認できません。再クリックせず、このページを読み込み直して状態を確認してください。';available=false; }
    busy=false;paintButton();
  });
  byId('recover').addEventListener('click',async () => {
    if (byId('recover').disabled || recovery === null) return;
    const target=recovery;
    busy=true;paintButton();
    try {
      const reply=await chrome.runtime.sendMessage({
        type:'clf-task-box-setup:recover-manual-delete',requestId:target.requestId,generation:target.generation,
        previousOutcomeReviewed:byId('recoveryReviewed').checked,
        manualProjectDeletionConfirmed:byId('manualDeleted').checked
      });
      if (!reply?.ok) {
        byId('status').textContent=`復旧を停止しました：${reply?.error || '不明な結果'}`;
      } else {
        await refresh();
      }
    } catch {
      byId('status').textContent='復旧結果を確認できません。再クリックせず、このページを読み込み直して状態を確認してください。';
    }
    busy=false;paintButton();
  });
  void refresh();
})();
