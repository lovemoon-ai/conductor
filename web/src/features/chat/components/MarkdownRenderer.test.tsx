import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

vi.mock('./MermaidDiagram', () => ({ MermaidDiagram: () => <div>Diagram</div> }));

const post = vi.fn();
vi.mock('@/shared/api/client', () => ({ getApiClient: () => ({ post }) }));

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

describe('MarkdownRenderer file links', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    post.mockReset();
  });

  /** A stand-in for the tab `window.open` returns. */
  function stubTab() {
    const tab = { opener: {}, document: { title: '', body: { textContent: '' } }, location: { replace: vi.fn() } };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    return { tab, open };
  }

  it('opens a daemon file link as a preview of the task', async () => {
    const { tab, open } = stubTab();
    post.mockResolvedValue({ viewUrl: '/preview/tok/report.md' });
    render(<MarkdownRenderer taskId="task-1" content="See the [report](/home/dev/docs/report.md:12)." />);

    fireEvent.click(screen.getByRole('link', { name: 'report' }));
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(post).toHaveBeenCalledWith('/tasks/task-1/preview', { path: '/home/dev/docs/report.md' }, { timeoutMs: 30_000 });
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('/preview/tok/report.md'));
  });

  it('understands relative, home and file:// links, and says why one failed', async () => {
    const { tab } = stubTab();
    post.mockRejectedValue(new Error('daemon ubuntu is not connected'));
    render(
      <MarkdownRenderer
        taskId="task-1"
        content={'[a](docs/%E6%8A%A5%E5%91%8A.html) [b](~/out/chart.png) [c](file:///tmp/x.html#top)'}
      />,
    );

    for (const name of ['a', 'b', 'c']) fireEvent.click(screen.getByRole('link', { name }));
    expect(post.mock.calls.map((call) => call[1].path)).toEqual(['docs/报告.html', '~/out/chart.png', '/tmp/x.html']);
    await waitFor(() => expect(tab.document.body.textContent).toMatch(/daemon ubuntu is not connected/));
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it('leaves ordinary links alone', () => {
    const { open } = stubTab();
    // Keep the test DOM from actually following the links it clicks.
    const stay = (event: Event) => event.preventDefault();
    document.addEventListener('click', stay);
    onTestFinished(() => document.removeEventListener('click', stay));
    const content = '[web](https://example.com/a.html) [app](/app/tasks) [mail](mailto:a@b.c) [src](/repo/main.rs)';
    render(<MarkdownRenderer taskId="task-1" content={content} />);
    for (const name of ['web', 'app', 'mail', 'src']) fireEvent.click(screen.getByRole('link', { name }));
    expect(open).not.toHaveBeenCalled();

    // No task (shared transcripts, daily reports): a file link stays a plain link.
    render(<MarkdownRenderer content="[plain](/home/dev/report.md)" />);
    fireEvent.click(screen.getByRole('link', { name: 'plain' }));
    expect(open).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows a picture and a recording from the daemon in place', async () => {
    post.mockImplementation(async (_url: string, body: { path: string }) => ({
      url: `/api/preview/tok/${body.path.split('/').pop()}`,
      viewUrl: 'unused',
    }));
    const { container, rerender } = render(
      <MarkdownRenderer taskId="task-media" content={'![chart](out/chart.png)\n\n![demo](/home/dev/out/demo.mp4)'} />,
    );
    // Until the preview exists there is nothing to load, only the name.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('chart')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('img', { name: 'chart' })).toHaveAttribute('src', '/api/preview/tok/chart.png'));
    // The recording is not fetched for merely being on screen…
    expect(container.querySelector('video')).toBeNull();
    expect(post.mock.calls.map((call) => call[1].path)).toEqual(['out/chart.png']);

    // …only once it is asked for.
    fireEvent.click(screen.getByRole('button', { name: /demo/ }));
    await waitFor(() => expect(container.querySelector('video')).toHaveAttribute('src', '/api/preview/tok/demo.mp4'));
    expect(container.querySelector('video')).toHaveAttribute('controls');
    expect(post.mock.calls.map((call) => call[1].path)).toEqual(['out/chart.png', '/home/dev/out/demo.mp4']);

    // Re-rendering the reply does not ask again.
    rerender(<MarkdownRenderer taskId="task-media" content={'![chart](out/chart.png) again'} />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'chart' })).toHaveAttribute('src', '/api/preview/tok/chart.png'));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('asks once more when the daemon was only busy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    post
      .mockRejectedValueOnce(Object.assign(new Error('too many concurrent remote file transfers'), { status: 429 }))
      .mockResolvedValueOnce({ url: '/api/preview/tok/busy.png', viewUrl: 'unused' });
    render(<MarkdownRenderer taskId="task-busy" content="![busy](out/busy.png)" />);

    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(1500));
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByRole('img', { name: 'busy' })).toHaveAttribute('src', '/api/preview/tok/busy.png'));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('says why a picture could not be shown, and leaves remote and unowned images alone', async () => {
    post.mockRejectedValue(new Error('daemon ubuntu is not connected'));
    const { container } = render(
      <MarkdownRenderer taskId="task-off" content={'![chart](out/missing.png) ![logo](https://example.com/logo.png)'} />,
    );
    await waitFor(() => expect(screen.getByText(/chart \(daemon ubuntu is not connected\)/)).toBeInTheDocument());
    expect(screen.getByRole('img', { name: 'logo' })).toHaveAttribute('src', 'https://example.com/logo.png');
    expect(post).toHaveBeenCalledTimes(1);

    // Without a task (shared transcript) nothing is requested.
    post.mockClear();
    render(<MarkdownRenderer content="![chart](out/chart.png)" />);
    expect(post).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it('resolves relative links and images inside a previewed document', () => {
    render(
      <MarkdownRenderer
        previewToken="tok"
        previewPath="docs/guide/index.md"
        content={'![v](clip.mp4)\n\n![d](img/a%20b.png) [next](../next.md) [page](./demo.html) [up](../../../../etc.md) [web](https://example.com)'}
      />,
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/preview/tok/docs/guide/img/a%20b.png');
    expect(document.querySelector('video')).toHaveAttribute('src', '/api/preview/tok/docs/guide/clip.mp4');
    // Nothing is fetched until play is pressed.
    expect(document.querySelector('video')).toHaveAttribute('preload', 'none');
    // Markdown stays in the viewer; anything else is served directly.
    expect(screen.getByRole('link', { name: 'next' })).toHaveAttribute('href', '/preview/tok/docs/next.md');
    expect(screen.getByRole('link', { name: 'page' })).toHaveAttribute('href', '/api/preview/tok/docs/guide/demo.html');
    // Climbing past the root cannot name anything outside it.
    expect(screen.getByRole('link', { name: 'up' })).toHaveAttribute('href', '/preview/tok/etc.md');
    expect(screen.getByRole('link', { name: 'web' })).toHaveAttribute('href', 'https://example.com');
  });
});
