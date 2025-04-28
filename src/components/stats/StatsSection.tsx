
import { useStats } from '@/hooks/useStats';
import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

export function StatsSection() {
  const { data, isLoading } = useStats();
  const [isVisible, setIsVisible] = useState(false);
  
  useEffect(() => {
    setIsVisible(true);
  }, []);
  
  return (
    <section className="bg-accent rounded-xl p-6 md:p-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-10">
        <StatCard
          title="Producers"
          value={data?.producers || 0}
          isLoading={isLoading}
          isVisible={isVisible}
        />
        <StatCard
          title="Artists"
          value={data?.artists || 0}
          isLoading={isLoading}
          isVisible={isVisible}
        />
        <StatCard
          title="Tracks"
          value={data?.tracks || 0}
          isLoading={isLoading}
          isVisible={isVisible}
        />
      </div>
    </section>
  );
}

interface StatCardProps {
  title: string;
  value: number;
  isLoading: boolean;
  isVisible: boolean;
}

function StatCard({ title, value, isLoading, isVisible }: StatCardProps) {
  // We will implement a simple count-up animation without the library
  const [displayValue, setDisplayValue] = useState(0);
  
  useEffect(() => {
    if (!isVisible || isLoading) return;
    
    // Simple count-up animation
    let start = 0;
    const end = value;
    const duration = 2000; // 2 seconds
    const frameDuration = 1000 / 60; // 60fps
    const totalFrames = Math.round(duration / frameDuration);
    const increment = end / totalFrames;
    
    let currentFrame = 0;
    const counter = setInterval(() => {
      currentFrame++;
      const progress = easeOutQuad(currentFrame / totalFrames);
      const currentCount = Math.floor(progress * end);
      
      setDisplayValue(currentCount);
      
      if (currentFrame === totalFrames) {
        clearInterval(counter);
      }
    }, frameDuration);
    
    return () => clearInterval(counter);
  }, [value, isVisible, isLoading]);
  
  // Easing function for smoother animation
  const easeOutQuad = (t: number) => t * (2 - t);
  
  return (
    <div className="text-center">
      <h3 className="text-lg font-medium text-muted-foreground mb-2">{title}</h3>
      <div className="text-4xl font-bold">
        {isLoading ? (
          <Skeleton className="h-12 w-24 mx-auto" />
        ) : isVisible ? (
          displayValue.toLocaleString()
        ) : value.toLocaleString()}
      </div>
    </div>
  );
}
