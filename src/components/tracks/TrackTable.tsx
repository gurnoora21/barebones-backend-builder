
import { useState, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Filter, Calendar, User, Disc } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/common/UserAvatar';

interface TrackTableProps {
  tracks: any[];
  isLoading: boolean;
  error: any;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  orderBy: { column: string; ascending: boolean };
  setOrderBy: (orderBy: { column: string; ascending: boolean }) => void;
  filters: {
    year?: number;
    artistId?: string;
    albumId?: string;
  };
  setFilters: (filters: any) => void;
}

export function TrackTable({
  tracks,
  isLoading,
  error,
  page,
  setPage,
  pageSize,
  orderBy,
  setOrderBy,
  filters,
  setFilters,
}: TrackTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  
  // Extract unique years, artists, and albums for filters
  const years = useMemo(() => {
    const yearsSet = new Set<number>();
    tracks.forEach((tp: any) => {
      if (tp.tracks?.albums?.release_date) {
        const year = new Date(tp.tracks.albums.release_date).getFullYear();
        if (!isNaN(year)) {
          yearsSet.add(year);
        }
      }
    });
    return Array.from(yearsSet).sort((a, b) => b - a);
  }, [tracks]);
  
  const artists = useMemo(() => {
    const artistsMap = new Map<string, any>();
    tracks.forEach((tp: any) => {
      const artist = tp.tracks?.albums?.artists;
      if (artist && !artistsMap.has(artist.id)) {
        artistsMap.set(artist.id, artist);
      }
    });
    return Array.from(artistsMap.values());
  }, [tracks]);
  
  const albums = useMemo(() => {
    const albumsMap = new Map<string, any>();
    tracks.forEach((tp: any) => {
      const album = tp.tracks?.albums;
      if (album && !albumsMap.has(album.id)) {
        albumsMap.set(album.id, album);
      }
    });
    return Array.from(albumsMap.values());
  }, [tracks]);
  
  // We'll implement a simpler virtualization approach without the external library
  const [visibleItems, setVisibleItems] = useState<number[]>([]);
  
  // Set up a useEffect to handle the visible tracks when the container is scrolled
  const handleScroll = () => {
    if (!parentRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    const itemHeight = 64; // estimated height of each row
    
    // Calculate visible range
    const startIndex = Math.floor(scrollTop / itemHeight);
    const endIndex = Math.ceil((scrollTop + clientHeight) / itemHeight);
    
    // Create an array of visible indices with some overscan
    const overscan = 5;
    const start = Math.max(0, startIndex - overscan);
    const end = Math.min(tracks.length - 1, endIndex + overscan);
    
    const indices = [];
    for (let i = start; i <= end; i++) {
      indices.push(i);
    }
    
    setVisibleItems(indices);
  };
  
  // Use useMemo to create the style for the container that simulates the full height
  const containerStyle = useMemo(() => {
    return {
      height: `${tracks.length * 64}px`, // each row is approximately 64px tall
      position: 'relative' as const,
      width: '100%',
    };
  }, [tracks.length]);
  
  const handleSort = (column: string) => {
    if (orderBy.column === column) {
      setOrderBy({ column, ascending: !orderBy.ascending });
    } else {
      setOrderBy({ column, ascending: false });
    }
  };
  
  const handleYearFilter = (year: number | undefined) => {
    setFilters({ ...filters, year });
    setPage(1);
  };
  
  const handleArtistFilter = (artistId: string | undefined) => {
    setFilters({ ...filters, artistId });
    setPage(1);
  };
  
  const handleAlbumFilter = (albumId: string | undefined) => {
    setFilters({ ...filters, albumId });
    setPage(1);
  };
  
  const activeFiltersCount = Object.values(filters).filter(Boolean).length;
  
  const clearFilters = () => {
    setFilters({});
    setPage(1);
  };

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          Failed to load tracks. Please try again.
        </p>
      </div>
    );
  }
  
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center">
          <h2 className="text-lg font-semibold">Produced Tracks</h2>
          {activeFiltersCount > 0 && (
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={clearFilters}
              className="ml-2 text-xs"
            >
              Clear filters ({activeFiltersCount})
            </Button>
          )}
        </div>
        
        <div className="flex gap-2">
          {/* Year filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex items-center">
                <Calendar className="h-4 w-4 mr-2" />
                {filters.year ? filters.year : 'Year'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[300px] overflow-y-auto">
              <DropdownMenuItem onClick={() => handleYearFilter(undefined)}>
                All Years
              </DropdownMenuItem>
              {years.map((year) => (
                <DropdownMenuItem key={year} onClick={() => handleYearFilter(year)}>
                  {year}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          
          {/* Artist filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex items-center">
                <User className="h-4 w-4 mr-2" />
                Artist
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[300px] overflow-y-auto">
              <DropdownMenuItem onClick={() => handleArtistFilter(undefined)}>
                All Artists
              </DropdownMenuItem>
              {artists.map((artist) => (
                <DropdownMenuItem key={artist.id} onClick={() => handleArtistFilter(artist.id)}>
                  {artist.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          
          {/* Album filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex items-center">
                <Disc className="h-4 w-4 mr-2" />
                Album
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[300px] overflow-y-auto">
              <DropdownMenuItem onClick={() => handleAlbumFilter(undefined)}>
                All Albums
              </DropdownMenuItem>
              {albums.map((album) => (
                <DropdownMenuItem key={album.id} onClick={() => handleAlbumFilter(album.id)}>
                  {album.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      
      <div className="border rounded-md">
        <table className="min-w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th 
                className="px-4 py-3 text-left text-sm font-medium text-muted-foreground"
                onClick={() => handleSort('tracks.name')}
              >
                <div className="flex items-center cursor-pointer">
                  Track
                  {orderBy.column === 'tracks.name' && (
                    orderBy.ascending ? 
                      <ChevronUp className="ml-1 h-4 w-4" /> : 
                      <ChevronDown className="ml-1 h-4 w-4" />
                  )}
                </div>
              </th>
              <th 
                className="px-4 py-3 text-left text-sm font-medium text-muted-foreground"
                onClick={() => handleSort('tracks.albums.artists.name')}
              >
                <div className="flex items-center cursor-pointer">
                  Artist
                  {orderBy.column === 'tracks.albums.artists.name' && (
                    orderBy.ascending ? 
                      <ChevronUp className="ml-1 h-4 w-4" /> : 
                      <ChevronDown className="ml-1 h-4 w-4" />
                  )}
                </div>
              </th>
              <th 
                className="px-4 py-3 text-left text-sm font-medium text-muted-foreground hidden md:table-cell"
                onClick={() => handleSort('tracks.albums.name')}
              >
                <div className="flex items-center cursor-pointer">
                  Album
                  {orderBy.column === 'tracks.albums.name' && (
                    orderBy.ascending ? 
                      <ChevronUp className="ml-1 h-4 w-4" /> : 
                      <ChevronDown className="ml-1 h-4 w-4" />
                  )}
                </div>
              </th>
              <th 
                className="px-4 py-3 text-left text-sm font-medium text-muted-foreground hidden md:table-cell"
                onClick={() => handleSort('tracks.albums.release_date')}
              >
                <div className="flex items-center cursor-pointer">
                  Year
                  {orderBy.column === 'tracks.albums.release_date' && (
                    orderBy.ascending ? 
                      <ChevronUp className="ml-1 h-4 w-4" /> : 
                      <ChevronDown className="ml-1 h-4 w-4" />
                  )}
                </div>
              </th>
            </tr>
          </thead>
        </table>
        
        <div 
          ref={parentRef}
          className="overflow-auto h-[500px]"
          onScroll={handleScroll}
        >
          <div style={containerStyle}>
            <table className="min-w-full">
              <tbody>
                {isLoading ? (
                  <TrackTableSkeleton rows={pageSize} />
                ) : tracks.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center">
                      <p className="text-muted-foreground">No tracks found</p>
                      {activeFiltersCount > 0 && (
                        <Button 
                          variant="link" 
                          onClick={clearFilters}
                          className="mt-2"
                        >
                          Clear filters
                        </Button>
                      )}
                    </td>
                  </tr>
                ) : (
                  tracks.map((tp, index) => {
                    const track = tp.tracks;
                    const album = track?.albums;
                    const artist = album?.artists;
                    const year = album?.release_date ? new Date(album.release_date).getFullYear() : null;
                    
                    // Calculate position for this row
                    const top = index * 64; // each row is approximately 64px
                    
                    return (
                      <tr 
                        key={tp.id || index}
                        style={{
                          position: 'absolute',
                          top: `${top}px`,
                          left: 0,
                          width: '100%',
                        }}
                        className="border-b hover:bg-muted/50 transition-colors"
                      >
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className="font-medium">{track?.name || 'Untitled'}</div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          {artist ? (
                            <div className="flex items-center">
                              <Link 
                                to={`/artist/${artist.id}`}
                                className="hover:underline hover:text-primary flex items-center"
                              >
                                <UserAvatar 
                                  name={artist.name} 
                                  imageUrl={artist.metadata?.image_url} 
                                  size="sm"
                                  className="mr-2 h-6 w-6"
                                />
                                <span>{artist.name}</span>
                              </Link>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">Unknown</span>
                          )}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap hidden md:table-cell">
                          {album?.name || 'Unknown'}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap hidden md:table-cell">
                          {year || 'Unknown'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      
      <div className="flex justify-center mt-6">
        <Button 
          onClick={() => setPage(1)}
          disabled={page === 1 || isLoading}
          variant="outline"
          className="mr-2"
        >
          Previous
        </Button>
        <Button
          onClick={() => setPage(page + 1)}
          disabled={tracks.length < pageSize || isLoading}
          variant="outline"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function TrackTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <>
      {Array(rows).fill(0).map((_, i) => (
        <tr key={i} className="border-b">
          <td className="px-4 py-4">
            <Skeleton className="h-5 w-full max-w-[200px]" />
          </td>
          <td className="px-4 py-4">
            <div className="flex items-center">
              <Skeleton className="h-6 w-6 rounded-full mr-2" />
              <Skeleton className="h-5 w-32" />
            </div>
          </td>
          <td className="px-4 py-4 hidden md:table-cell">
            <Skeleton className="h-5 w-40" />
          </td>
          <td className="px-4 py-4 hidden md:table-cell">
            <Skeleton className="h-5 w-10" />
          </td>
        </tr>
      ))}
    </>
  );
}
