import {parse} from '@babel/parser';
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (node.type) visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'extra', 'comments', 'tokens'].includes(key)) walk(child, visit);
  }
}

// Catch valid JavaScript that changes Chrome arguments during wrapper migrations.
// Dynamic option objects still require behavior tests and browser acceptance.
export function inspectBrowserCalls(source, filename = 'source.js') {
  const errors = [];
  const ast = parse(source, {sourceType:'unambiguous'});
  const report = (node, message) => errors.push(`${filename}:${node.loc.start.line}: ${message}`);
  walk(ast, node => {
    if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        if (property.type !== 'SpreadElement') continue;
        walk(property.argument, part => {
          if (part.type === 'SequenceExpression') report(part, 'Comma expression inside object spread can discard options.');
        });
        if (['StringLiteral','ArrayExpression','NumericLiteral','BooleanLiteral'].includes(property.argument.type)) {
          report(property, 'Object spread requires an options object, not a literal value or array.');
        }
      }
    }
    if (node.type !== 'CallExpression') return;
    const name = node.callee.type === 'Identifier' ? node.callee.name : '';
    const contracts = {createProfileTab:[3,4,1,2], updateProfileTab:[4,4,2,3], readProfileOnTab:[5,5,null,4]};
    const contract = contracts[name];
    if (!contract) return;
    const [min,max,optionsIndex,sourceIndex] = contract;
    if (node.arguments.length < min || node.arguments.length > max) report(node, `${name} expects ${min === max ? min : `${min}-${max}`} arguments.`);
    const options = node.arguments[optionsIndex];
    if (optionsIndex !== null && options && !['ObjectExpression','Identifier','MemberExpression'].includes(options.type)) report(options, `${name} requires a separate options object.`);
    const origin = node.arguments[sourceIndex];
    if (origin && ['ObjectExpression','ArrayExpression','NumericLiteral','NullLiteral'].includes(origin.type)) report(origin, `${name} requires a separate source string.`);
  });
  return errors;
}

export function inspectBrowserSourceTree(root) {
  const errors = [];
  let files = 0;
  function visit(dir) {
    for (const entry of readdirSync(dir, {withFileTypes:true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!/\.(js|vue)$/.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      const scripts = entry.name.endsWith('.vue') ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]) : [source];
      files++;
      for (const script of scripts) errors.push(...inspectBrowserCalls(script, relative(root,path)));
    }
  }
  visit(root);
  return {files, errors};
}
