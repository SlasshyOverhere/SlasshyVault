import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertCircle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { ChatBubble } from './ChatBubble';
import { TypingIndicator } from './TypingIndicator';
import { ChatInput } from './ChatInput';
import {
  getChatHistory,
  onSocialEvent,
  ChatMessage,
  Friend,
} from '@/services/social';

interface ChatWindowProps {
  friend: Friend;
  onClose: () => void;
}

export function ChatWindow({ friend, onClose }: ChatWindowProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadChatHistory();

    // Subscribe to chat events
    const unsubMessage = onSocialEvent('chat_message', (data) => {
      if (data.fromUserId === friend.id) {
        setMessages(prev => [...prev, data.message as ChatMessage]);
      }
    });

    const unsubSent = onSocialEvent('chat_message_sent', (data) => {
      if (data.friendId === friend.id) {
        setMessages(prev => [...prev, data.message as ChatMessage]);
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
  }, [friend.id]);

  useEffect(() => {
    // Auto-scroll to bottom when messages change
    scrollToBottom();
  }, [messages]);

  const loadChatHistory = async () => {
    try {
      setLoading(true);
      setError(null);
      const history = await getChatHistory(friend.id);
      setMessages(history);
    } catch (err) {
      console.error('Failed to load chat history:', err);
      setError('Failed to load chat history. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const scrollToBottom = () => {
    if (scrollAreaRef.current) {
      const scrollElement = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollElement) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    }
  };

  const retryLoad = () => {
    loadChatHistory();
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
                <img src={friend.avatar} alt={friend.name + "'s avatar"} className="w-full h-full object-cover" />
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
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Messages */}
        <ScrollArea className="flex-1 p-3" ref={scrollAreaRef}>
          {error ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-4">
              <AlertCircle className="w-8 h-8 text-red-500 mb-2" />
              <p className="text-red-400 text-sm mb-2">Error loading messages</p>
              <p className="text-zinc-500 text-xs">{error}</p>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-3 border-zinc-700"
                onClick={retryLoad}
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
              <p className="text-xs">Start a conversation with {friend.name}!</p>
            </div>
          ) : (
            <div className="space-y-2">
              {messages.map((msg) => {
                const isOwn = msg.senderId !== friend.id;
                return (
                  <ChatBubble
                    key={msg.id}
                    message={msg}
                    isOwn={isOwn}
                    showSenderInfo={!isOwn} // Only show sender info for received messages
                  />
                );
              })}
              
              {isTyping && (
                <TypingIndicator text={`${friend.name} is typing...`} />
              )}
            </div>
          )}
        </ScrollArea>

        {/* Input */}
        <ChatInput 
          friendId={friend.id} 
        />
      </motion.div>
    </AnimatePresence>
  );
}