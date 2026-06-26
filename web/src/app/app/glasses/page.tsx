'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { SETTINGS_ROOT_PATH } from '@/features/settings';
import {
  glasses,
  isGlassesShell,
  registerGlassesEvents,
  type GlassDevice,
} from '@/features/glasses/native-bridge';

/**
 * Glasses settings sub-page (reached from the Settings "Rokid 眼镜" entry). Connection control
 * plus on-glasses display tuning (text size, brightness). Only meaningful inside the Android
 * shell; in a normal browser it redirects back to Settings.
 */
export default function GlassesSettingsPage() {
  const { replace, push } = useRouter();
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('眼镜未连接');
  const [devices, setDevices] = useState<GlassDevice[]>([]);
  const [fontSize, setFontSize] = useState(22);
  const [brightness, setBrightness] = useState(5);

  useEffect(() => {
    if (!isGlassesShell()) {
      replace(SETTINGS_ROOT_PATH);
      return;
    }
    setReady(true);
    setConnected(glasses.isConnected());
    setDevices(glasses.listDevices());
    setFontSize(glasses.getFontSize());
    setBrightness(glasses.getBrightness());
    return registerGlassesEvents({
      onGlassStatus: (isConnected, text) => {
        setConnected(isConnected);
        setStatus(text);
      },
    });
  }, [replace]);

  if (!ready) return null;

  return (
    <div className="flex h-full flex-col bg-paper">
      <Header title="Rokid 眼镜" showBack onBack={() => push(SETTINGS_ROOT_PATH)} compact />
      <div className="flex-1 overflow-y-auto p-4 space-y-4 webapp-scrollbar">
        {/* Connection */}
        <section className="webapp-card p-5">
          <div className="flex items-center gap-3 mb-4">
            <h3 className="font-semibold text-lg">连接</h3>
            <span
              className={`ml-auto inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${
                connected ? 'bg-success/10 text-success' : 'bg-paper text-muted border border-border'
              }`}
            >
              <span className={`size-2 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-muted'}`} />
              {connected ? '已连接' : '未连接'}
            </span>
          </div>

          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm text-muted truncate">{status}</p>
            {connected ? (
              <button
                onClick={() => glasses.disconnect()}
                className="shrink-0 text-sm px-3 py-1.5 rounded-lg border border-border text-red-500 hover:bg-[var(--border)] transition-colors"
              >
                断开
              </button>
            ) : (
              <button
                onClick={() => setDevices(glasses.listDevices())}
                className="shrink-0 text-sm px-3 py-1.5 rounded-lg border border-border hover:bg-[var(--border)] transition-colors"
              >
                刷新设备
              </button>
            )}
          </div>

          {!connected && (
            <div className="space-y-2">
              {devices.length === 0 ? (
                <div className="text-center py-6 text-muted">
                  <p className="text-sm">没有已配对的蓝牙设备</p>
                  <p className="text-xs mt-1">请先在系统蓝牙设置里配对眼镜</p>
                </div>
              ) : (
                devices.map((d) => (
                  <button
                    key={d.mac}
                    onClick={() => glasses.connect(d.mac)}
                    className="w-full flex items-center gap-3 p-3 bg-paper border border-border rounded-lg text-left transition-colors hover:bg-[var(--accent)]/5 hover:border-[var(--accent)]/40"
                  >
                    <div className="size-2 bg-muted rounded-full shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{d.name}</p>
                      <p className="text-xs text-muted font-mono truncate">{d.mac}</p>
                    </div>
                    <span className="text-xs text-accent shrink-0">连接</span>
                  </button>
                ))
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">连接后,打开任意任务对话即自动投到眼镜;说完停顿一下自动发送。</p>
        </section>

        {/* Display tuning */}
        <section className="webapp-card p-5 space-y-5">
          <h3 className="font-semibold text-lg">镜片显示</h3>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm">字体大小</span>
              <span className="text-sm text-muted font-mono">{fontSize}sp</span>
            </div>
            <input
              type="range"
              min={14}
              max={40}
              step={1}
              value={fontSize}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFontSize(v);
                glasses.setFontSize(v);
              }}
              className="w-full accent-[var(--accent)]"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm">亮度</span>
              <span className="text-sm text-muted font-mono">{brightness} / 15</span>
            </div>
            <input
              type="range"
              min={0}
              max={15}
              step={1}
              value={brightness}
              onChange={(e) => {
                const v = Number(e.target.value);
                setBrightness(v);
                glasses.setBrightness(v);
              }}
              className="w-full accent-[var(--accent)]"
            />
            <p className="mt-2 text-xs text-muted">亮度越低,文字鬼影/倒影越轻。</p>
          </div>
        </section>
      </div>
    </div>
  );
}
