import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceModeButton, VoiceRecordingBar, VoiceStatus } from './VoiceControls';

describe('VoiceControls', () => {
  it('the button icon and label say what a tap does', () => {
    const { rerender } = render(<VoiceModeButton phase="off" onClick={() => {}} />);
    const button = screen.getByTestId('message-input-voice-button');
    expect(button).toHaveAttribute('aria-label', 'Voice conversation');
    rerender(<VoiceModeButton phase="recording" onClick={() => {}} />);
    expect(button).toHaveAttribute('aria-label', 'Send');
    rerender(<VoiceModeButton phase="speaking" onClick={() => {}} />);
    expect(button).toHaveAttribute('aria-label', 'Stop speaking');
    rerender(<VoiceModeButton phase="recognizing" onClick={() => {}} />);
    expect(button).toBeDisabled();
    rerender(<VoiceModeButton phase="idle" onClick={() => {}} />);
    expect(button).toHaveAttribute('aria-label', 'Talk');
  });

  it('the recording bar shows the live transcript, a timer, the level and ✕', () => {
    vi.useFakeTimers();
    let push: (level: number) => void = () => {};
    const onCancel = vi.fn();
    const subscribe = (listener: (level: number) => void) => {
      push = listener;
      return () => {};
    };
    const { rerender } = render(
      <VoiceRecordingBar phase="recording" partial="" since={Date.now()} subscribeLevel={subscribe} onCancel={onCancel} />,
    );
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('Listening… start talking');
    rerender(<VoiceRecordingBar phase="recording" partial="帮我看一下测试" since={Date.now()} subscribeLevel={subscribe} onCancel={onCancel} />);
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent('帮我看一下测试');

    act(() => push(0.8));
    expect(screen.getByTestId('voice-level-meter')).toHaveAttribute('data-level', '0.80');
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByTestId('voice-recording-timer')).toHaveTextContent('1:05');

    fireEvent.click(screen.getByTestId('voice-cancel-button'));
    expect(onCancel).toHaveBeenCalled();
    rerender(<VoiceRecordingBar phase="recognizing" partial="帮我看一下测试" since={null} subscribeLevel={subscribe} onCancel={onCancel} />);
    expect(screen.queryByTestId('voice-cancel-button')).toBeNull();
    vi.useRealTimers();
  });

  it('the status line never repeats the transcript', () => {
    render(<VoiceStatus phase="recording" error="" onExit={() => {}} />);
    expect(screen.getByTestId('voice-status')).toHaveTextContent('Recording · tap ↑ to sendExit voice');
  });
});
