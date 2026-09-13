import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { emptyState, createTask } from '../src/domain.mjs';

const make = (id, title, extra = {}) => ({ ...createTask({ title, dueDate: '2026-09-08' }, '2026-09-08T01:00:00Z', id), ...extra });
const state = {
  ...emptyState(),
  categories: [{id:'work',name:'工作',color:'#32654d'},{id:'life',name:'生活',color:'#b9784a'},{id:'study',name:'学习',color:'#4676a9'}],
  tags: [{id:'project',name:'新项目',color:'#32654d'},{id:'writing',name:'写作',color:'#8262ad'}],
  tasks: [
    make('ideas','整理新项目的灵感与参考',{categoryId:'work',priority:'high',tagIds:['project'],notes:'整理参考资料，确定下一步的方向。',subtasks:[{id:'s1',title:'收集参考',completed:true},{id:'s2',title:'整理方向',completed:false},{id:'s3',title:'补充草图',completed:false}]}),
    make('team','和团队确认本周的交付计划',{categoryId:'work',dueTime:'14:30',reminder:{offsetMinutes:15}}),
    make('book','读完《设计心理学》第二章',{categoryId:'study'}),
    make('plants','给家里的绿植浇水',{categoryId:'life',dueDate:'2026-09-07'}),
    make('daily','写下今天的三点收获',{categoryId:'study',tagIds:['writing'],recurrence:{frequency:'daily',anchorDate:'2026-09-08',until:null},seriesId:'daily'}),
    make('walk','傍晚出门走走，买一束花',{categoryId:'life',dueTime:'18:00'}),
    make('talk','准备产品分享',{categoryId:'work',dueDate:'2026-09-10',dueTime:'15:00'}),
    make('weekend','和朋友一起去看展',{categoryId:'life',dueDate:'2026-09-12',dueTime:'10:00'}),
    make('review','整理本月的阅读笔记',{categoryId:'study',dueDate:'2026-09-25'}),
    make('desk','整理书桌',{categoryId:'life',completedAt:'2026-09-08T01:30:00Z'}),
  ],
};
await mkdir('docs/themes',{recursive:true});
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1280,height:960},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-08T10:00:00+08:00'));
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(data=>localStorage.setItem('sidetask.preview.v3',JSON.stringify(data)),state);
  await page.reload();await expect(page.locator('body')).toHaveAttribute('data-ready','true');
  for(const theme of ['pine','mist','sand','graphite']) {
    await page.locator('#settings-open').click();
    await page.locator('[data-theme-choice="'+theme+'"]').click();
    await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('sidetask.preview.v3')).settings.themePreset)).toBe(theme);
    await page.locator('[data-close="settings-dialog"]').click();
    for(const view of ['day','week','month']) {
      await page.locator('#tab-'+view).click();
      await expect(page.locator('#shell')).toHaveCSS('width',view==='day'?'420px':'1120px');
      await expect(page.locator('#projection-status')).toHaveText('');
      await page.locator('#shell').screenshot({path:'docs/themes/'+theme+'-'+view+'.png',animations:'disabled'});
      if(theme==='pine') await page.locator('#shell').screenshot({path:'docs/'+(view==='day'?'preview':view)+'.png',animations:'disabled'});
    }
  }
  await page.locator('#settings-open').click();await page.locator('[data-theme-choice="pine"]').click();await page.locator('[data-close="settings-dialog"]').click();
  await page.locator('#tab-day').click();
  await page.getByRole('button',{name:'编辑：整理新项目的灵感与参考',exact:true}).click();
  await page.locator('#shell').screenshot({path:'docs/details.png',animations:'disabled'});
  await page.locator('#detail-back').click();
  await page.locator('#taxonomy-open').click();
  await page.locator('#shell').screenshot({path:'docs/categories.png',animations:'disabled'});
  if(errors.length) throw new Error(errors.join('\n'));
  console.log('Captured four themes, day/week/month, details and classification manager.');
} finally { await browser.close(); }
