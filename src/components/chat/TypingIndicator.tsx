import { motion } from 'framer-motion';

interface TypingIndicatorProps {
  text: string;
}

export function TypingIndicator({ text }: TypingIndicatorProps): JSX.Element {
  return (
    <div className="flex items-center gap-2 mb-4 px-4">
      <div className="flex items-center gap-1">
        <motion.div
          className="w-2 h-2 bg-zinc-400 rounded-full"
          animate={{ y: [0, -5, 0] }}
          transition={{ repeat: Infinity, duration: 1, delay: 0 }}
        />
        <motion.div
          className="w-2 h-2 bg-zinc-400 rounded-full"
          animate={{ y: [0, -5, 0] }}
          transition={{ repeat: Infinity, duration: 1, delay: 0.2 }}
        />
        <motion.div
          className="w-2 h-2 bg-zinc-400 rounded-full"
          animate={{ y: [0, -5, 0] }}
          transition={{ repeat: Infinity, duration: 1, delay: 0.4 }}
        />
      </div>
      <span className="text-sm text-zinc-400">{text}</span>
    </div>
  );
}