(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  let available = false;
  let busy = false;
  function paintButton() {
    byId('enable').disabled = busy || !available || !byId('oldDisabled').checked || !byId('reviewed').checked;
  }
  async function refresh() {
    try {
      const state = await chrome.runtime.sendMessage({type:'clf-task-box-setup:status'});
      available = state?.ok === true && state.available === true && state.enabled !== true;
      byId('status').textContent = state?.enabled && state?.available ? '統合版は有効です。TASK BOXページを一度読み込み直してください。' :
        state?.enabled ? '設定は有効ですが、現在は対応アプリへの接続を確認できません。BOX CLEARは押さないでください。' :
        available ? '対応アプリへの接続を確認しました。切替前の2点を確認してください。' :
        `まだ有効化できません：${state?.error || '対応するアプリが未反映です。'}`;
    } catch { byId('status').textContent='拡張との接続が切れました。この設定ページを読み込み直してください。';available=false; }
    paintButton();
  }
  byId('oldDisabled').addEventListener('change',paintButton);
  byId('reviewed').addEventListener('change',paintButton);
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
  void refresh();
})();
