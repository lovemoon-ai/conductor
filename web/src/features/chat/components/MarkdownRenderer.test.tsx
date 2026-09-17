import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

vi.mock('./MermaidDiagram', () => ({ MermaidDiagram: () => <div>Diagram</div> }));

describe('MarkdownRenderer reading content', () => {
  it('uses a single scrollable block for fenced code and preserves inline code', () => {
    const { container } = render(<MarkdownRenderer content={'Use `font-size`.\n\n```css\nbody { font-size: 16px; }\n```'} />);
    expect(container.querySelectorAll('pre')).toHaveLength(1);
    expect(container.querySelector('pre pre')).toBeNull();
    expect(container.querySelector('pre')).toHaveClass('overflow-x-auto');
    expect(screen.getByText('font-size').tagName).toBe('CODE');
    expect(container.querySelector('pre code')).toHaveTextContent('body { font-size: 16px; }');
  });
  it('keeps table and list semantics in dense transcripts', () => {
    render(<MarkdownRenderer content={'| Device | Size |\n| --- | --- |\n| Mobile | 16px |\n\n- First\n- Second'} />);
    expect(screen.getByRole('table')).toHaveTextContent('Mobile16px');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
