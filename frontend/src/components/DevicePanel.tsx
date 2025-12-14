import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ScrcpyPlayer } from './ScrcpyPlayer';
import type {
  ScreenshotResponse,
  StepEvent,
  DoneEvent,
  ErrorEvent,
} from '../api';
import { getScreenshot, initAgent, resetChat, sendMessageStream } from '../api';

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  steps?: number;
  success?: boolean;
  thinking?: string[];
  actions?: Record<string, unknown>[];
  isStreaming?: boolean;
}

// 全局配置接口
interface GlobalConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}
// DevicePanel Props 接口
interface DevicePanelProps {
  deviceId: string;
  deviceName: string;
  config: GlobalConfig;
  isVisible: boolean;
}

export function DevicePanel({
  deviceId,
  deviceName,
  config,
}: DevicePanelProps) {
  // ========== 内部状态管理 ==========
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [screenshot, setScreenshot] = useState<ScreenshotResponse | null>(null);
  const [useVideoStream, setUseVideoStream] = useState(true);
  const [videoStreamFailed, setVideoStreamFailed] = useState(false);
  const [displayMode, setDisplayMode] = useState<
    'auto' | 'video' | 'screenshot'
  >('auto');
  const [tapFeedback, setTapFeedback] = useState<string | null>(null);

  // 选项卡显示状态管理
  const [areTabsVisible, setAreTabsVisible] = useState(() => {
    try {
      const saved = localStorage.getItem('display-tabs-visible');
      return saved !== null ? JSON.parse(saved) : true;
    } catch (error) {
      console.warn('Failed to load tabs visibility state:', error);
      return true;
    }
  });

  // 保存选项卡显示状态到 localStorage
  useEffect(() => {
    localStorage.setItem(
      'display-tabs-visible',
      JSON.stringify(areTabsVisible)
    );
  }, [areTabsVisible]);

  // Refs for resource cleanup
  const chatStreamRef = useRef<{ close: () => void } | null>(null);
  const videoStreamRef = useRef<{ close: () => void } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const screenshotFetchingRef = useRef(false);

  // ========== 内部业务逻辑 ==========

  // 初始化 Agent
  const handleInit = useCallback(async () => {
    if (!config) {
      console.warn('[DevicePanel] config is required for handleInit');
      return;
    }

    try {
      await initAgent({
        model_config: {
          base_url: config.baseUrl || undefined,
          api_key: config.apiKey || undefined,
          model_name: config.modelName || undefined,
        },
        agent_config: {
          device_id: deviceId,
        },
      });
      setInitialized(true);
      setError(null);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : '初始化失败，请检查配置';
      setError(errorMessage);
    }
  }, [deviceId, config]);

  // 发送消息（SSE 流处理）
  const handleSend = useCallback(async () => {
    const inputValue = input.trim();
    if (!inputValue || loading) return;

    if (!initialized) {
      await handleInit();
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    // 为每个请求创建独立的数组，避免多设备并发时的数据混乱
    const thinkingList: string[] = [];
    const actionsList: Record<string, unknown>[] = [];

    const agentMessageId = (Date.now() + 1).toString();
    const agentMessage: Message = {
      id: agentMessageId,
      role: 'agent',
      content: '',
      timestamp: new Date(),
      thinking: [],
      actions: [],
      isStreaming: true,
    };

    setMessages(prev => [...prev, agentMessage]);

    // 启动流式接收（deviceId 自动正确，无闭包陷阱）
    const stream = sendMessageStream(
      userMessage.content,
      deviceId,
      // onStep
      (event: StepEvent) => {
        thinkingList.push(event.thinking);
        actionsList.push(event.action);

        setMessages(prev =>
          prev.map(msg =>
            msg.id === agentMessageId
              ? {
                  ...msg,
                  thinking: [...thinkingList],
                  actions: [...actionsList],
                  steps: event.step,
                }
              : msg
          )
        );
      },
      // onDone
      (event: DoneEvent) => {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === agentMessageId
              ? {
                  ...msg,
                  content: event.message,
                  success: event.success,
                  isStreaming: false,
                }
              : msg
          )
        );
        setLoading(false);
        chatStreamRef.current = null;
      },
      // onError
      (event: ErrorEvent) => {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === agentMessageId
              ? {
                  ...msg,
                  content: `错误: ${event.message}`,
                  success: false,
                  isStreaming: false,
                }
              : msg
          )
        );
        setLoading(false);
        setError(event.message);
        chatStreamRef.current = null;
      }
    );

    chatStreamRef.current = stream;
  }, [input, loading, initialized, deviceId, handleInit]);

  // 重置对话
  const handleReset = useCallback(async () => {
    if (chatStreamRef.current) {
      chatStreamRef.current.close();
    }

    setMessages([]);
    setLoading(false);
    setError(null);
    chatStreamRef.current = null;

    await resetChat(deviceId);
  }, [deviceId]);

  // 滚动到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // ========== 资源清理（组件卸载时） ==========
  useEffect(() => {
    return () => {
      console.log(`[DevicePanel] 设备 ${deviceId} 卸载，清理资源`);

      // 关闭聊天流
      if (chatStreamRef.current) {
        chatStreamRef.current.close();
        chatStreamRef.current = null;
      }

      // 关闭视频流
      if (videoStreamRef.current) {
        videoStreamRef.current.close();
        videoStreamRef.current = null;
      }
    };
  }, [deviceId]);

  // 截图轮询
  useEffect(() => {
    if (!deviceId) return;

    const shouldPollScreenshots =
      displayMode === 'screenshot' ||
      (displayMode === 'auto' && videoStreamFailed);

    if (!shouldPollScreenshots) {
      return;
    }

    const fetchScreenshot = async () => {
      if (screenshotFetchingRef.current) return;

      screenshotFetchingRef.current = true;
      try {
        const data = await getScreenshot(deviceId);
        if (data.success) {
          setScreenshot(data);
        }
      } catch (e) {
        console.error('Failed to fetch screenshot:', e);
      } finally {
        screenshotFetchingRef.current = false;
      }
    };

    fetchScreenshot();
    const interval = setInterval(fetchScreenshot, 500);

    return () => clearInterval(interval);
  }, [deviceId, videoStreamFailed, displayMode]);

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSend();
    }
  };

  // 处理视频流就绪事件
  const handleVideoStreamReady = useCallback(
    (stream: { close: () => void } | null) => {
      videoStreamRef.current = stream;
    },
    []
  );

  // 处理视频流降级到截图模式
  const handleFallback = useCallback(() => {
    setVideoStreamFailed(true);
    setUseVideoStream(false);
  }, []);

  // 切换选项卡显示状态
  const toggleTabsVisibility = () => {
    setAreTabsVisible(!areTabsVisible);
  };

  return (
    <div className="flex-1 flex gap-4 p-4 items-stretch justify-center min-h-0">
      {/* Chatbox */}
      <div className="flex flex-col w-full max-w-2xl min-h-0 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-lg bg-white dark:bg-gray-800">
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 rounded-t-2xl">
          <div>
            <h2 className="text-lg font-semibold">{deviceName}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {deviceId}
            </p>
          </div>
          <div className="flex gap-2">
            {!initialized ? (
              <button
                onClick={handleInit}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm"
              >
                初始化设备
              </button>
            ) : (
              <span className="px-3 py-1 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-full text-sm">
                已初始化
              </span>
            )}
            <button
              onClick={handleReset}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors text-sm"
            >
              重置
            </button>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="mx-4 mt-4 p-3 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-200 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
          {messages.length === 0 ? (
            <div className="text-center text-gray-500 dark:text-gray-400 mt-8">
              <p className="text-lg">设备已选择</p>
              <p className="text-sm mt-2">输入任务描述，让 AI 帮你操作手机</p>
            </div>
          ) : null}

          {messages.map(message => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {message.role === 'agent' ? (
                <div className="max-w-[80%] space-y-2">
                  {/* 显示每步思考过程 */}
                  {message.thinking?.map((think, idx) => (
                    <div
                      key={idx}
                      className="bg-gray-100 dark:bg-gray-700 rounded-2xl px-4 py-3 border-l-4 border-blue-500"
                    >
                      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                        💭 步骤 {idx + 1} - 思考过程
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{think}</p>

                      {message.actions?.[idx] && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-blue-500 hover:text-blue-600">
                            查看动作
                          </summary>
                          <pre className="mt-1 p-2 bg-gray-800 text-gray-200 rounded overflow-x-auto text-xs">
                            {JSON.stringify(message.actions[idx], null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}

                  {/* 最终结果 */}
                  {message.content && (
                    <div
                      className={`rounded-2xl px-4 py-3 ${
                        message.success === false
                          ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200'
                          : 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                      {message.steps !== undefined && (
                        <p className="text-xs mt-2 opacity-70">
                          总步数: {message.steps}
                        </p>
                      )}
                    </div>
                  )}

                  {/* 流式加载提示 */}
                  {message.isStreaming && (
                    <div className="text-sm text-gray-500 dark:text-gray-400 animate-pulse">
                      正在执行...
                    </div>
                  )}
                </div>
              ) : (
                <div className="max-w-[70%] rounded-2xl px-4 py-3 bg-blue-500 text-white">
                  <p className="whitespace-pre-wrap">{message.content}</p>
                </div>
              )}
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>

        {/* 输入区域 */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 rounded-b-2xl">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder={!initialized ? '请先初始化设备' : '输入任务描述...'}
              disabled={loading}
              className="flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="px-6 py-3 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              发送
            </button>
          </div>
        </div>
      </div>

      {/* Screen Monitor */}
      <div className="w-full max-w-xs min-h-0 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-lg bg-gray-900 overflow-hidden relative">
        {/* 附着的选项卡开关按钮（选项卡隐藏时显示） */}
        {!areTabsVisible && (
          <button
            onClick={toggleTabsVisibility}
            className="absolute top-2 right-2 z-10 w-8 h-8 bg-blue-500 hover:bg-blue-600 text-white rounded-full shadow-lg transition-all duration-300 flex items-center justify-center"
            title="显示选项卡"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
              />
            </svg>
          </button>
        )}

        {/* Mode Switch Button */}
        <div
          className={`${areTabsVisible ? 'absolute top-2 right-2' : 'hidden'} z-10 flex gap-1 bg-black/70 rounded-lg p-1`}
        >
          <button
            onClick={() => setDisplayMode('auto')}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              displayMode === 'auto'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            自动
          </button>
          <button
            onClick={() => setDisplayMode('video')}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              displayMode === 'video'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            视频流
          </button>
          <button
            onClick={() => setDisplayMode('screenshot')}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              displayMode === 'screenshot'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            截图
          </button>

          {/* 隐藏选项卡按钮 */}
          <button
            onClick={toggleTabsVisibility}
            className="ml-1 px-2 py-1 text-xs rounded transition-colors bg-gray-600 text-gray-300 hover:bg-gray-500"
            title="隐藏选项卡"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {displayMode === 'video' ||
        (displayMode === 'auto' && useVideoStream && !videoStreamFailed) ? (
          <>
            {tapFeedback && (
              <div className="absolute top-14 right-2 z-20 px-3 py-2 bg-blue-500 text-white text-sm rounded-lg shadow-lg">
                {tapFeedback}
              </div>
            )}

            <ScrcpyPlayer
              deviceId={deviceId}
              className="w-full h-full"
              enableControl={true}
              onFallback={handleFallback}
              onTapSuccess={() => {
                setTapFeedback('Tap executed');
                setTimeout(() => setTapFeedback(null), 2000);
              }}
              onTapError={error => {
                setTapFeedback(`Tap failed: ${error}`);
                setTimeout(() => setTapFeedback(null), 3000);
              }}
              onSwipeSuccess={() => {
                setTapFeedback('Swipe executed');
                setTimeout(() => setTapFeedback(null), 2000);
              }}
              onSwipeError={error => {
                setTapFeedback(`Swipe failed: ${error}`);
                setTimeout(() => setTapFeedback(null), 3000);
              }}
              onStreamReady={handleVideoStreamReady}
              fallbackTimeout={100000}
            />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gray-900 min-h-0">
            {screenshot && screenshot.success ? (
              <div className="relative w-full h-full flex items-center justify-center min-h-0">
                <img
                  src={`data:image/png;base64,${screenshot.image}`}
                  alt="Device Screenshot"
                  className="max-w-full max-h-full object-contain"
                  style={{
                    width:
                      screenshot.width > screenshot.height ? '100%' : 'auto',
                    height:
                      screenshot.width > screenshot.height ? 'auto' : '100%',
                  }}
                />
                {screenshot.is_sensitive && (
                  <div className="absolute top-12 right-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded">
                    敏感内容
                  </div>
                )}
                <div className="absolute bottom-2 left-2 px-2 py-1 bg-blue-500 text-white text-xs rounded">
                  截图模式 (0.5s 刷新)
                  {displayMode === 'auto' &&
                    videoStreamFailed &&
                    ' - 视频流不可用'}
                </div>
              </div>
            ) : screenshot?.error ? (
              <div className="text-center text-red-500 dark:text-red-400">
                <p className="mb-2">截图失败</p>
                <p className="text-xs">{screenshot.error}</p>
              </div>
            ) : (
              <div className="text-center text-gray-500 dark:text-gray-400">
                <div className="w-8 h-8 border-4 border-gray-300 border-t-blue-500 rounded-full animate-spin mx-auto mb-2" />
                <p>加载中...</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
