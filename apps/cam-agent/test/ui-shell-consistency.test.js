import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { agentPage } from '../../../agent-web/page.js';

const source = (path) => new URL(path, import.meta.url);

test('Edge, Core and Agent shell branding and navigation labels are aligned', async () => {
  const [edge, edgeAccount, core, coreScript] = await Promise.all([
    readFile(source('../../../edge-web/index.html'), 'utf8'),
    readFile(source('../../../edge-web/account-ui.js'), 'utf8'),
    readFile(source('../../../core-web/index.html'), 'utf8'),
    readFile(source('../../../core-web/core.js'), 'utf8')
  ]);
  const agent = agentPage();

  assert.match(edge, /<title>CAM Edge · 制品管理<\/title>/);
  assert.match(edge, /href="#products">CAM Edge · 制品管理/);
  assert.match(edge, /breadcrumb-item">CAM Edge/);
  assert.match(edgeAccount, /CAM Edge · 制品管理/);
  assert.match(edge, /id="grants-nav" data-menu-group-item="business"/);
  assert.match(edge, /id="users-nav" data-menu-group-item="security"/);
  assert.match(edge, /id="audit-nav" data-menu-group-item="audit"/);
  assert.ok(!edgeAccount.includes("document.querySelector('[data-menu-group=\"management\"]')?.before($('#grants-nav'))"));

  assert.match(core, /<title>CAM Core · 内网发布审批<\/title>/);
  assert.match(core, /CAM Core · 内网发布审批/);
  assert.ok(core.includes('brand-text">CAM Core'));
  assert.ok(core.includes('id="page-title" class="mb-0">审批请求'));
  assert.ok(coreScript.includes("$('.sidebar-brand .brand-text').textContent = 'CAM Core'"));
  assert.ok(coreScript.includes("$('#page-artifacts .card-title').textContent = '正式制品'"));
  assert.ok(coreScript.includes("$('#page-distribution .card-title').textContent = 'Agent 分发'"));

  assert.match(agent, /<title>CAM Agent · 制品缓存<\/title>/);
  assert.match(agent, /\.cam-agent-shell \.app-content\{min-height:auto\}/);
  assert.match(agent, /CAM Agent · 制品缓存/);
  assert.ok(agent.includes('brand-text">CAM Agent'));
  assert.doesNotMatch(agent, /私钥只保存在本机<br>任务由 Core 授权后自动拉取/);
  assert.match(agent, /CAM Agent';/);
  assert.match(agent, /Agent 接入/);
  assert.match(agent, /id="identity-center-id"/);
  assert.match(agent, /id="identity-agent-name"/);
  assert.match(agent, /id="identity-fingerprint" class="form-text font-monospace text-break mt-2"/);
  assert.doesNotMatch(agent, /statusItem\('配置来源'/);
  assert.match(agent, /statusItem\('过渡公钥指纹'/);
  assert.match(agent, /<p>Agent 接入<\/p>/);
  assert.match(agent, /<h3 class="card-title">正式制品<\/h3>/);
  assert.match(agent, /<section id="page-delivery"/);
  assert.match(agent, /data-agent-menu-group-item="business" data-agent-permission="deliveryRead"><a href="#delivery"/);
  assert.doesNotMatch(agent, /if\(deliveryPage\)\$\('#page-tasks'\)\.after\(deliveryPage\)/);
  assert.doesNotMatch(agent, /data-page="cache"|id="page-cache"/);
  assert.match(agent, /id="artifact-cache-summary"/);
  assert.match(agent, /正式版本总数/);
  assert.match(agent, /showCacheColumns:true/);
  assert.match(agent, /传输计划由 Core 统一安排，Agent 到时自动主动下载/);
  assert.match(agent, /canDeliver:item=>Boolean\(item\.distributionAuthorized\)/);
  assert.match(agent, /id="task-detail-dialog"/);
  assert.match(agent, /立即同步任务/);
});
