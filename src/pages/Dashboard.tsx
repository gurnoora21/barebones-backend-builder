
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
import { AlertCircle, CheckCircle } from "lucide-react";

interface QueueMetrics {
  queue_name: string;
  hour: string;
  messages_processed: number;
  success_count: number;
  error_count: number;
  avg_processing_ms: number | null;
  max_processing_ms: number | null;
}

interface DeadLetterAnalysis {
  queue_name: string;
  error_category: string | null;
  error_count: number;
  last_occurrence: string;
  first_occurrence: string;
}

const ARTIST_NAMES = [
  "Drake",
  "Taylor Swift",
  "The Weeknd",
  "Ariana Grande",
  "Kendrick Lamar",
  "Beyoncé",
  "Post Malone",
  "Billie Eilish",
  "Ed Sheeran",
  "Bruno Mars"
];

export default function Dashboard() {
  const [artistName, setArtistName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  // Fetch queue metrics
  const { data: queueStats, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ['queueStats'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('queue_stats')
        .select('*')
        .order('hour', { ascending: false });
      
      if (error) throw error;
      return data as QueueMetrics[];
    }
  });

  // Fetch dead letter items
  const { data: deadLetterAnalysis, isLoading: deadLetterLoading, refetch: refetchDeadLetters } = useQuery({
    queryKey: ['deadLetterAnalysis'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dead_letter_analysis')
        .select('*')
        .order('error_count', { ascending: false });
      
      if (error) throw error;
      return data as DeadLetterAnalysis[];
    }
  });

  // Submit an artist for discovery
  const handleSubmitArtist = async () => {
    if (!artistName.trim()) {
      toast({
        title: "Error",
        description: "Please enter an artist name",
        variant: "destructive"
      });
      return;
    }

    setIsSubmitting(true);
    
    try {
      const response = await fetch(`https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/artistDiscovery`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zeHh6aGhiY3d6YXR2bHVsZnlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ4NDQ4NDYsImV4cCI6MjA2MDQyMDg0Nn0.CR3TFPYipFCs6sL_51rJ3kOKR3iQGr8tJgZJ2GLlrDk`
        },
        body: JSON.stringify({ artistName })
      });
      
      const data = await response.json();
      
      if (data.success) {
        toast({
          title: "Success",
          description: `Artist discovery task for "${artistName}" has been queued!`,
        });
        setArtistName("");
        
        // Refetch data after a short delay to see updates
        setTimeout(() => {
          refetchStats();
          refetchDeadLetters();
        }, 2000);
      } else {
        throw new Error(data.error || "Failed to queue artist discovery");
      }
    } catch (error) {
      console.error("Error submitting artist:", error);
      toast({
        title: "Error",
        description: `Failed to queue artist: ${error instanceof Error ? error.message : String(error)}`,
        variant: "destructive"
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit a predefined artist
  const handleQuickSubmit = (name: string) => {
    setArtistName(name);
    setTimeout(handleSubmitArtist, 100);
  };

  return (
    <div className="container mx-auto py-10 px-4">
      <h1 className="text-3xl font-bold mb-8">Spotify Producer Discovery Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
        <Card>
          <CardHeader>
            <CardTitle>Discover New Artist</CardTitle>
            <CardDescription>Submit an artist name to start the discovery pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="Enter artist name"
                value={artistName}
                onChange={(e) => setArtistName(e.target.value)}
                className="flex-1"
              />
              <Button onClick={handleSubmitArtist} disabled={isSubmitting || !artistName.trim()}>
                {isSubmitting ? "Submitting..." : "Submit"}
              </Button>
            </div>
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            {ARTIST_NAMES.map(name => (
              <Button 
                key={name} 
                variant="outline" 
                size="sm" 
                onClick={() => handleQuickSubmit(name)}
                disabled={isSubmitting}
              >
                {name}
              </Button>
            ))}
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Worker Status</CardTitle>
            <CardDescription>Current status of data processing workers</CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <p>Loading worker stats...</p>
            ) : queueStats && queueStats.length > 0 ? (
              <div className="space-y-4">
                {['artist_discovery', 'album_discovery', 'track_discovery', 'producer_identification', 'social_enrichment']
                  .map(queueName => {
                    const stats = queueStats.find(s => s.queue_name === queueName);
                    return (
                      <div key={queueName} className="flex items-center justify-between">
                        <span className="capitalize">{queueName.replace('_', ' ')}</span>
                        {stats ? (
                          <div className="flex items-center space-x-2">
                            <CheckCircle className="h-4 w-4 text-green-500" />
                            <span>{stats.messages_processed} processed</span>
                            <span className="text-green-500">{stats.success_count} success</span>
                            {stats.error_count > 0 && (
                              <span className="text-red-500">{stats.error_count} errors</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400">No activity</span>
                        )}
                      </div>
                    )
                  })}
              </div>
            ) : (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>No Worker Activity</AlertTitle>
                <AlertDescription>
                  No worker activity detected yet. Try submitting an artist to start the pipeline.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter>
            <Button variant="outline" onClick={() => {
              refetchStats();
              refetchDeadLetters();
              toast({ title: "Refreshed", description: "Data has been refreshed" });
            }}>
              Refresh Stats
            </Button>
          </CardFooter>
        </Card>
      </div>

      <Tabs defaultValue="deadLetters" className="w-full">
        <TabsList>
          <TabsTrigger value="deadLetters">Error Analysis</TabsTrigger>
          <TabsTrigger value="queueMetrics">Queue Metrics</TabsTrigger>
        </TabsList>
        
        <TabsContent value="deadLetters" className="space-y-4">
          <h2 className="text-xl font-semibold">Error Analysis</h2>
          
          {deadLetterLoading ? (
            <p>Loading error data...</p>
          ) : deadLetterAnalysis && deadLetterAnalysis.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="text-left p-2 border-b">Queue</th>
                    <th className="text-left p-2 border-b">Error Type</th>
                    <th className="text-left p-2 border-b">Count</th>
                    <th className="text-left p-2 border-b">First Occurrence</th>
                    <th className="text-left p-2 border-b">Last Occurrence</th>
                  </tr>
                </thead>
                <tbody>
                  {deadLetterAnalysis.map((item, i) => (
                    <tr key={i} className={i % 2 === 0 ? "bg-gray-50" : ""}>
                      <td className="p-2 border-b">{item.queue_name}</td>
                      <td className="p-2 border-b">
                        <span className={
                          item.error_category === 'permission_denied' ? "text-red-600 font-medium" : 
                          item.error_category === 'rate_limit' ? "text-yellow-600 font-medium" : ""
                        }>
                          {item.error_category}
                        </span>
                      </td>
                      <td className="p-2 border-b">{item.error_count}</td>
                      <td className="p-2 border-b">{new Date(item.first_occurrence).toLocaleString()}</td>
                      <td className="p-2 border-b">{new Date(item.last_occurrence).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No errors reported yet.</p>
          )}
        </TabsContent>
        
        <TabsContent value="queueMetrics">
          <h2 className="text-xl font-semibold mb-4">Queue Processing Metrics</h2>
          
          {statsLoading ? (
            <p>Loading metrics...</p>
          ) : queueStats && queueStats.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="text-left p-2 border-b">Queue</th>
                    <th className="text-left p-2 border-b">Time Period</th>
                    <th className="text-left p-2 border-b">Processed</th>
                    <th className="text-left p-2 border-b">Success</th>
                    <th className="text-left p-2 border-b">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {queueStats.map((stat, i) => (
                    <tr key={i} className={i % 2 === 0 ? "bg-gray-50" : ""}>
                      <td className="p-2 border-b">{stat.queue_name}</td>
                      <td className="p-2 border-b">{new Date(stat.hour).toLocaleString()}</td>
                      <td className="p-2 border-b">{stat.messages_processed}</td>
                      <td className="p-2 border-b text-green-600">{stat.success_count}</td>
                      <td className="p-2 border-b text-red-600">{stat.error_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No queue metrics available yet.</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
