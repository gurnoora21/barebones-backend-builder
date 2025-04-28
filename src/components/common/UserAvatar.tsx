
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

interface UserAvatarProps {
  name: string;
  imageUrl?: string | null;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function UserAvatar({ name, imageUrl, className = '', size = 'md' }: UserAvatarProps) {
  const initials = name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .substring(0, 2);
  
  const sizeClasses = {
    sm: 'h-8 w-8',
    md: 'h-10 w-10',
    lg: 'h-16 w-16',
  };
  
  return (
    <Avatar className={`${sizeClasses[size]} ${className}`}>
      {imageUrl && <AvatarImage src={imageUrl} alt={name} />}
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  );
}
