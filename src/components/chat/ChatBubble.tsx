import { formatRelativeTime } from '@/services/social';
import { User } from 'lucide-react';

interface ChatBubbleProps {
  message: {
    id: string;
    senderId: string;
    senderName?: string;
    senderAvatar?: string;
    text: string;
    timestamp: number;
  };
  isOwn: boolean;
  showSenderInfo?: boolean;
}

export function ChatBubble({ message, isOwn, showSenderInfo = true }: ChatBubbleProps): JSX.Element {
  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-4`}>
      <div className={`flex max-w-[80%] ${isOwn ? 'flex-row-reverse' : 'flex-row'} items-start gap-2`}>
        {/* Avatar */}
        {!isOwn && showSenderInfo && (
          <div className="w-8 h-8 rounded-full bg-zinc-700 overflow-hidden flex-shrink-0">
            {message.senderAvatar ? (
              <img
                src={message.senderAvatar}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs">
                {message.senderName?.charAt(0).toUpperCase() || '?'}
              </div>
            )}
          </div>
        )}

        {/* Message Bubble */}
        <div
          className={`px-4 py-2 rounded-2xl ${
            isOwn
              ? 'bg-purple-600 text-white rounded-br-none'
              : 'bg-zinc-700 text-white rounded-bl-none'
          }`}
        >
          {/* Sender Name */}
          {!isOwn && showSenderInfo && message.senderName && (
            <div className="text-xs font-semibold mb-1">{message.senderName}</div>
          )}
          
          {/* Message Text */}
          <div className="text-sm">{message.text}</div>
          
          {/* Timestamp */}
          <div className={`text-xs mt-1 ${isOwn ? 'text-purple-200' : 'text-zinc-400'} text-right`}>
            {formatRelativeTime(message.timestamp)}
          </div>
        </div>

        {/* Own Avatar */}
        {isOwn && showSenderInfo && (
          <div className="w-8 h-8 rounded-full bg-zinc-700 overflow-hidden flex-shrink-0">
            <User className="w-full h-full p-1 text-zinc-500" />
          </div>
        )}
      </div>
    </div>
  );
}