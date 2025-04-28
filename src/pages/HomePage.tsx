
import { useState } from 'react';
import { useStats } from '@/hooks/useStats';
import { useQuery } from '@tanstack/react-query';
import { fetchList } from '@/lib/supabase';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProducerGrid } from '@/components/producers/ProducerGrid';
import { ArtistGrid } from '@/components/artists/ArtistGrid';
import { StatsSection } from '@/components/stats/StatsSection';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  // For trending/hidden gems tabs
  const [currentTab, setCurrentTab] = useState('trending');
  
  // For pagination
  const [page, setPage] = useState(1);
  const pageSize = 12;
  
  // Fetch trending producers (those with most track credits)
  const trendingProducersQuery = useQuery({
    queryKey: ['trendingProducers', page, pageSize],
    queryFn: () => fetchList('producers', {
      page,
      pageSize,
      orderBy: { column: 'popularity', ascending: false },
    }),
    keepPreviousData: true,
  });
  
  // Fetch "hidden gems" producers (those with high quality but fewer credits)
  const hiddenGemsQuery = useQuery({
    queryKey: ['hiddenGems', page, pageSize],
    queryFn: () => fetchList('producers', {
      page,
      pageSize,
      filters: { popularity: 'low' },
      orderBy: { column: 'popularity', ascending: true },
    }),
    keepPreviousData: true,
    enabled: currentTab === 'hidden',
  });
  
  const statsQuery = useStats();
  
  return (
    <div className="space-y-12">
      <section className="text-center px-4">
        <h1 className="text-4xl font-bold tracking-tight">
          Discover Music Producers
        </h1>
        <p className="mt-4 text-xl text-muted-foreground max-w-2xl mx-auto">
          Explore the talent behind your favorite music. From chart-toppers to hidden gems.
        </p>
      </section>
      
      <StatsSection />
      
      <section className="mt-16">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold">Discover Producers</h2>
          <Tabs value={currentTab} onValueChange={setCurrentTab}>
            <TabsList>
              <TabsTrigger value="trending">Trending</TabsTrigger>
              <TabsTrigger value="hidden">Hidden Gems</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        
        <TabsContent value="trending" className="mt-0">
          {trendingProducersQuery.isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {Array(pageSize).fill(0).map((_, i) => (
                <div key={i} className="h-48 bg-muted rounded-lg animate-pulse" />
              ))}
            </div>
          ) : (
            <ProducerGrid producers={trendingProducersQuery.data?.data || []} />
          )}
        </TabsContent>
        
        <TabsContent value="hidden" className="mt-0">
          {hiddenGemsQuery.isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {Array(pageSize).fill(0).map((_, i) => (
                <div key={i} className="h-48 bg-muted rounded-lg animate-pulse" />
              ))}
            </div>
          ) : (
            <ProducerGrid producers={hiddenGemsQuery.data?.data || []} />
          )}
        </TabsContent>
        
        <div className="mt-8 flex justify-center">
          <Button 
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            variant="outline"
            className="mr-2"
          >
            Previous
          </Button>
          <Button
            onClick={() => setPage(p => p + 1)}
            disabled={
              (currentTab === 'trending' && !trendingProducersQuery.data?.data?.length) ||
              (currentTab === 'hidden' && !hiddenGemsQuery.data?.data?.length)
            }
            variant="outline"
          >
            Next
          </Button>
        </div>
      </section>
      
      <section className="mt-16">
        <h2 className="text-2xl font-bold mb-6">Popular Artists</h2>
        <ArtistGrid />
      </section>
    </div>
  );
}
