import { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sendTypingIndicator, sendChatMessage } from '@/services/social';

interface ChatInputProps {
  friendId: string;
}

export function ChatInput({ friendId }: ChatInputProps) {
  const [message, setMessage] = useState('');
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleSend = () => {
    if (message.trim()) {
      void sendChatMessage(friendId, message.trim());
      setMessage('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setMessage(text);

    // Send typing indicator when user starts typing
    if (text.trim() && !typingTimeoutRef.current) {
      sendTypingIndicator(friendId);
    }

    // Clear previous timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set new timeout to stop sending typing indicator after 1 second of inactivity
    typingTimeoutRef.current = setTimeout(() => {
      typingTimeoutRef.current = null;
    }, 1000);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="flex items-center gap-2 p-4 border-t border-zinc-800">
      <Input
        placeholder="Type a message..."
        value={message}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        className="flex-1 bg-zinc-800 border-zinc-700 text-sm"
      />
      <Button
        size="icon"
        onClick={handleSend}
        disabled={!message.trim()}
        className="bg-purple-600 hover:bg-purple-700"
      >
        <Send className="w-4 h-4" />
      </Button>
    </div>
  );
}
