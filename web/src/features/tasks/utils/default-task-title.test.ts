import { describe, expect, it } from 'vitest';
import { deriveDefaultTaskTitle } from './default-task-title';

describe('deriveDefaultTaskTitle', () => {
  it('uses the first clause when it ends within the width budget', () => {
    expect(deriveDefaultTaskTitle('修复登录问题，然后补充单元测试并更新文档')).toBe('修复登录问题');
    expect(deriveDefaultTaskTitle('Fix login bug. Then add tests.')).toBe('Fix login bug');
    expect(deriveDefaultTaskTitle('优化设置页\n保持设备控制容易找到')).toBe('优化设置页');
  });

  it('caps the title at 10 CJK or 20 Latin characters when no clause break fits', () => {
    expect(deriveDefaultTaskTitle('帮我把任务列表页面在移动端的显示效果优化一下')).toBe('帮我把任务列表页面在');
    expect(deriveDefaultTaskTitle('Improve the settings page layout for phones')).toBe('Improve the settings');
    expect(deriveDefaultTaskTitle('修复 login 页面在 iPhone 上的样式')).toBe('修复 login 页面在');
    expect(deriveDefaultTaskTitle('Update Chrome DevTools settings')).toBe('Update Chrome');
    expect(deriveDefaultTaskTitle('Supercalifragilisticexpialidocious')).toBe('Supercalifragilistic');
  });

  it('keeps ASCII punctuation that is not followed by whitespace', () => {
    expect(deriveDefaultTaskTitle('Fix app.ts crash')).toBe('Fix app.ts crash');
  });
});
