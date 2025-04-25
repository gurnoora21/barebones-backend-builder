
import { useEffect, useState } from "react";
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { toast } from "sonner";
import { supabase } from "../integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { AlertCircle, RefreshCw } from "lucide-react";

interface QueueStat {
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
  error_category: string;
  error_count: number;
  last_occurrence: string;
  first_occurrence: string;
}

export default function Dashboard() {
  const [queueStats, setQueueStats] = useState<QueueStat[]>([]);
  const [deadLetterAnalysis, setDeadLetterAnalysis] = useState<DeadLetterAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async () => {
    setRefreshing(true);
    setError(null);
    
    try {
      // Fetch queue stats
      const { data: statsData, error: statsError } = await supabase
        .from('queue_stats')
        .select('*')
        .order('hour', { ascending: false });
        
      if (statsError) {
        throw new Error(`Error fetching queue stats: ${statsError.message}`);
      }
      
      // Fetch dead letter analysis
      const { data: deadLetterData, error: deadLetterError } = await supabase
        .from('dead_letter_analysis')
        .select('*')
        .order('error_count', { ascending: false });
        
      if (deadLetterError) {
        throw new Error(`Error fetching dead letter analysis: ${deadLetterError.message}`);
      }
      
      setQueueStats(statsData || []);
      setDeadLetterAnalysis(deadLetterData || []);
    } catch (err: any) {
      console.error("Error fetching data:", err);
      setError(err.message);
      toast.error("Failed to load queue data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const triggerArtistDiscovery = async (artistName: string) => {
    try {
      const response = await fetch(
        "https://nsxxzhhbcwzatvlulfyp.functions.supabase.co/artistDiscovery",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabase.auth.session()?.access_token}`,
          },
          body: JSON.stringify({ artistName }),
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      toast.success(`Started artist discovery for ${artistName}`);
      // Refresh data after a short delay to allow processing to begin
      setTimeout(fetchData, 5000);
    } catch (err: any) {
      console.error("Error triggering artist discovery:", err);
      toast.error(`Failed to trigger artist discovery: ${err.message}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading && !refreshing) {
    return <div className="flex items-center justify-center h-screen">Loading queue data...</div>;
  }

  return (
    <div className="container mx-auto p-4 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Queue Monitoring</h1>
        <Button 
          onClick={fetchData} 
          variant="outline" 
          size="sm"
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh Data
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            {error}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Test Artist Discovery</CardTitle>
            <CardDescription>
              Trigger an artist discovery task to test your queues
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {["Drake", "Taylor Swift", "The Beatles"].map((artist) => (
              <Button
                key={artist}
                onClick={() => triggerArtistDiscovery(artist)}
                className="mr-2"
                variant="outline"
              >
                Process {artist}
              </Button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dead Letter Issues</CardTitle>
            <CardDescription>
              Error analysis from failed messages
            </CardDescription>
          </CardHeader>
          <CardContent>
            {deadLetterAnalysis.length === 0 ? (
              <p className="text-muted-foreground">No dead letter issues found</p>
            ) : (
              <div className="space-y-4 max-h-96 overflow-auto">
                {deadLetterAnalysis.map((item, i) => (
                  <div key={i} className="border rounded p-3">
                    <p className="font-medium">{item.queue_name}</p>
                    <p className="text-sm text-muted-foreground">
                      {item.error_category}: {item.error_count} errors
                    </p>
                    <p className="text-xs text-muted-foreground">
                      First: {new Date(item.first_occurrence).toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last: {new Date(item.last_occurrence).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Queue Processing Stats</CardTitle>
            <CardDescription>
              Performance metrics for queue processing
            </CardDescription>
          </CardHeader>
          <CardContent>
            {queueStats.length === 0 ? (
              <p className="text-muted-foreground">No queue processing data found. Try triggering an artist discovery task.</p>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left p-2">Queue</th>
                      <th className="text-left p-2">Time</th>
                      <th className="text-right p-2">Total</th>
                      <th className="text-right p-2">Success</th>
                      <th className="text-right p-2">Errors</th>
                      <th className="text-right p-2">Avg Time (ms)</th>
                      <th className="text-right p-2">Max Time (ms)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queueStats.map((stat, i) => (
                      <tr key={i} className="border-b hover:bg-muted/50">
                        <td className="p-2">{stat.queue_name}</td>
                        <td className="p-2">{new Date(stat.hour).toLocaleString()}</td>
                        <td className="text-right p-2">{stat.messages_processed}</td>
                        <td className="text-right p-2">{stat.success_count}</td>
                        <td className="text-right p-2">{stat.error_count}</td>
                        <td className="text-right p-2">{stat.avg_processing_ms?.toFixed(2) || '-'}</td>
                        <td className="text-right p-2">{stat.max_processing_ms?.toFixed(2) || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
