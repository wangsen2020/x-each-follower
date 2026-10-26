import {watch, nextTick} from 'vue';

// Move focus before Vue applies hidden/aria-hidden to the drawer.
export function useDrawerFocus(isOpen, drawerId, fallbackId, doc = globalThis.document) {
  let opener;
  const stopClose = watch(isOpen, open => {
    if (!doc) return;
    if (open) {
      opener = doc.activeElement;
      return;
    }
    const drawer = doc.getElementById(drawerId);
    const active = doc.activeElement;
    if (!drawer?.contains(active)) return;
    const target = opener !== doc.body && opener?.isConnected && !drawer.contains(opener) && opener.getClientRects().length
      ? opener : doc.getElementById(fallbackId);
    target?.focus();
    if (drawer.contains(doc.activeElement)) active?.blur();
    nextTick(() => {
      if (!isOpen.value && doc.activeElement === doc.body) {
        (target?.isConnected ? target : doc.getElementById(fallbackId))?.focus();
      }
    });
  }, {flush:'sync'});
  const stopOpen=watch(isOpen, open=>{
    if(open)doc?.getElementById(drawerId)?.querySelector('button:not(:disabled)')?.focus();
  },{flush:'post'});
  return ()=>{stopClose();stopOpen();};
}
