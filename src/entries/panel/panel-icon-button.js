import {createElement} from 'lucide';

export const PANEL_ICON_ATTRIBUTES = Object.freeze({width:16, height:16, viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':1.75, 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true', focusable:'false'});

export function panelIcon(icon) {
  return createElement(icon, PANEL_ICON_ATTRIBUTES);
}

// The shared tooltip layer handles pointer and keyboard focus for these buttons.
export function panelIconButton(icon, {label, tip = label, className = '', onClick, ...attributes}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button secondary panel-icon-button ${className}`.trim();
  button.setAttribute('aria-label', label);
  button.setAttribute('data-panel-tip', tip);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'disabled') button.disabled = Boolean(value);
    else if (value !== undefined && value !== null) button.setAttribute(name, String(value));
  }
  if (onClick) button.addEventListener('click', onClick);
  button.appendChild(panelIcon(icon));
  return button;
}
