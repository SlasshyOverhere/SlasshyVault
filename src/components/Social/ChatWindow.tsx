import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, AlertCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getChatHistory,
  markChatMessagesRead,
  sendChatMessage,
  sendTypingIndicator,
  onSocialEvent,
  ChatMessage,
  Friend,
  formatRelativeTime
} from '@/services/social';

interface ChatWindowProps {
  friend: Friend;
  onClose: () => void;
}

export function ChatWindow({ friend, onClose }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => {
      if (prev.some((existing) => existing.id === message.id)) {
        return prev;
      }
      return [...prev, message];
    });
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const markConversationRead = useCallback(async () => {
    try {
      await markChatMessagesRead(friend.id);
    } catch (error) {
      console.warn('Failed to mark chat messages as read:', error);
    }
  }, [friend.id]);

  const loadChatHistory = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const history = await getChatHistory(friend.id);
      setMessages(history);
      await markConversationRead();
      setTimeout(scrollToBottom, 100);
    } catch (error) {
      console.error('Failed to load chat history:', error);
      setError('Failed to load chat history. Please try again later.');
    } finally {
      setLoading(false);
    }
  }, [friend.id, markConversationRead, scrollToBottom]);

  useEffect(() => {
    void loadChatHistory();

    const unsubMessage = onSocialEvent('chat_message', (data) => {
      if (data.fromUserId === friend.id) {
        if (data.message && typeof data.message === 'object' && 'id' in data.message) {
          appendMessage(data.message as ChatMessage);
        }
        void markConversationRead();
        scrollToBottom();
      }
    });

    const unsubSent = onSocialEvent('chat_message_sent', (data) => {
      if (data.friendId === friend.id) {
        if (data.message && typeof data.message === 'object' && 'id' in data.message) {
          appendMessage(data.message as ChatMessage);
        }
        scrollToBottom();
      }
    });

    const unsubTyping = onSocialEvent('typing', (data) => {
      if (data.userId === friend.id) {
        setIsTyping(true);
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
        }
        typingTimeoutRef.current = setTimeout(() => setIsTyping(false), 3000);
      }
    });

    return () => {
      unsubMessage();
      unsubSent();
      unsubTyping();
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [friend.id, appendMessage, loadChatHistory, markConversationRead, scrollToBottom]);

  const handleSend = async () => {
    if (!newMessage.trim() || sending) return;

    try {
      setSending(true);
      setError(null);
      const sentMessage = await sendChatMessage(friend.id, newMessage.trim());
      if (sentMessage) {
        appendMessage(sentMessage);
        setTimeout(scrollToBottom, 0);
      }
      setNewMessage('');
    } catch (error) {
      console.error('Failed to send message:', error);
      setError('Failed to send message. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);
    if (e.target.value.trim()) {
      sendTypingIndicator(friend.id);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 20, opacity: 0 }}
        className="fixed bottom-4 right-4 w-80 h-96 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl z-50 flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center gap-3 p-3 border-b border-zinc-800">
          <div className="relative">
            <div className="w-8 h-8 rounded-full bg-zinc-700 overflow-hidden">
              {friend.avatar ? (
                <img src={friend.avatar} alt={friend.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-zinc-400 text-sm">
                  {friend.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            {friend.isOnline && (
              <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-zinc-900" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{friend.name}</p>
            {isTyping && (
              <p className="text-xs text-purple-400">typing...</p>
            )}
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label={`Close chat with ${friend.name}`}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 p-3" ref={scrollRef}>
          {error ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-4">
              <AlertCircle className="w-8 h-8 text-red-500 mb-2" />
              <p className="text-red-400 text-sm mb-2">Error loading chat</p>
              <p className="text-zinc-500 text-xs">{error}</p>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-3 border-zinc-700"
                onClick={loadChatHistory}
                aria-label="Retry loading chat history"
              >
                Retry
              </Button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full text-zinc-500">
              Loading messages...
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 text-sm">
              <p>No messages yet</p>
              <p className="text-xs">Say hi to {friend.name}!</p>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((msg, index) => {
                const isOwn = msg.senderId !== friend.id;
                const showTimestamp = index === 0 ||
                  messages[index - 1].timestamp < msg.timestamp - 300000; // 5 min gap

                return (
                  <div key={msg.id}>
                    {showTimestamp && (
                      <div className="text-center text-xs text-zinc-500 my-2">
                        {formatRelativeTime(msg.timestamp)}
                      </div>
                    )}
                    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                          isOwn
                            ? 'bg-purple-600 text-white rounded-br-sm'
                            : 'bg-zinc-800 text-white rounded-bl-sm'
                        }`}
                      >
                        {msg.text}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {/* Input */}
        <div className="p-3 border-t border-zinc-800">
          <div className="flex gap-2">
            <Input
              placeholder="Type a message..."
              value={newMessage}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={sending}
              className="flex-1 bg-zinc-800 border-zinc-700 text-sm"
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!newMessage.trim() || sending}
              className="bg-purple-600 hover:bg-purple-700"
              aria-label="Send message"
            >
              {sending ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
