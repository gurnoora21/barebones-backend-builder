
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, AlertTriangle, CheckCircle } from "lucide-react";

export default function QueueMonitor() {
  const [queueStats, setQueueStats] = useState<any[]>([]);
  const [deadLetters, setDeadLetters] = useState<any[]>([]);
  const [workerIssues, setWorkerIssues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    
    try {
      // Fetch queue stats
      const { data: statsData, error: statsError } = await supabase
        .from('queue_stats')
        .select('*')
        .order('hour', { ascending: false });
      
      if (statsError) throw statsError;
      setQueueStats(statsData || []);
      
      // Fetch dead letter analysis
      const { data: deadLetterData, error: deadLetterError } = await supabase
        .from('dead_letter_analysis')
        .select('*')
        .order('error_count', { ascending: false });
      
      if (deadLetterError) throw deadLetterError;
      setDeadLetters(deadLetterData || []);
      
      // Fetch worker issues
      const { data: workerIssuesData, error: workerIssuesError } = await supabase
        .from('worker_issues')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (workerIssuesError) throw workerIssuesError;
      setWorkerIssues(workerIssuesData || []);

    } catch (error) {
      console.error("Error fetching monitoring data:", error);
      toast.error("Failed to load monitoring data");
    } finally {
      setLoading(false);
    }
  };

  const triggerArtistDiscovery = async (artistName = "Drake") => {
    try {
      const { error } = await supabase.functions.invoke('artistDiscovery', {
        body: { artistName }
      });
      
      if (error) throw error;
      
      toast.success(`Triggered artist discovery for "${artistName}"`);
      setTimeout(fetchData, 2000); // Refresh data after a delay
    } catch (error) {
      console.error("Error triggering artist discovery:", error);
      toast.error("Failed to trigger artist discovery");
    }
  };

  const scheduleWorkerInvocations = async () => {
    try {
      // Call the schedule_worker_invocations stored procedure
      const { error } = await supabase.rpc('call_schedule_worker_invocations');
      
      if (error) {
        throw error;
      }
      
      toast.success("Worker invocations scheduled successfully");
      setTimeout(fetchData, 2000); // Refresh data after a delay
    } catch (error) {
      console.error("Error scheduling worker invocations:", error);
      toast.error("Failed to schedule worker invocations");
    }
  };

  useEffect(() => {
    fetchData();
    
    // Set up auto-refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="container mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-3xl font-bold">Queue Monitoring Dashboard</h1>
        <div className="flex items-center gap-2">
          <Button 
            variant="outline" 
            onClick={fetchData}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          
          <Button onClick={scheduleWorkerInvocations}>
            Schedule Worker Invocations
          </Button>
          
          <Button onClick={() => triggerArtistDiscovery()}>
            Trigger Drake Discovery
          </Button>
        </div>
      </div>

      <Tabs defaultValue="stats">
        <TabsListWrapper>
          <TabsTrigger value="stats">Queue Stats</TabsTrigger>
          <TabsTrigger value="issues">Dead Letters</TabsTrigger>
          <TabsTrigger value="worker-issues">Worker Issues</TabsTrigger>
        </TabsListWrapper>

        <TabsContent value="stats" className="border rounded-md p-4">
          <h2 className="text-xl font-bold mb-4">Queue Stats</h2>
          {queueStats.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Processed</TableHead>
                  <TableHead>Success</TableHead>
                  <TableHead>Errors</TableHead>
                  <TableHead>Avg. Processing (ms)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queueStats.map((stat, idx) => (
                  <TableRow key={idx}>
                    <TableCell><strong>{stat.queue_name}</strong></TableCell>
                    <TableCell>{new Date(stat.hour).toLocaleString()}</TableCell>
                    <TableCell>{stat.messages_processed}</TableCell>
                    <TableCell className="text-green-600">{stat.success_count || 0}</TableCell>
                    <TableCell className="text-red-600">{stat.error_count || 0}</TableCell>
                    <TableCell>{stat.avg_processing_ms ? Math.round(stat.avg_processing_ms) : 'N/A'}</TableCell>
                  </TableRow>
                ))}
                {queueStats.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-4">
                      No queue statistics available
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center p-8 text-muted-foreground">
              {loading ? 'Loading queue statistics...' : 'No queue statistics available'}
            </div>
          )}
        </TabsContent>

        <TabsContent value="issues" className="border rounded-md p-4">
          <h2 className="text-xl font-bold mb-4">Dead Letter Analysis</h2>
          {deadLetters.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead>Error Category</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>First Seen</TableHead>
                  <TableHead>Last Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deadLetters.map((item, idx) => (
                  <TableRow key={idx}>
                    <TableCell><strong>{item.queue_name}</strong></TableCell>
                    <TableCell className="text-red-600">{item.error_category || 'unknown'}</TableCell>
                    <TableCell>{item.error_count}</TableCell>
                    <TableCell>{item.first_occurrence ? new Date(item.first_occurrence).toLocaleString() : 'N/A'}</TableCell>
                    <TableCell>{item.last_occurrence ? new Date(item.last_occurrence).toLocaleString() : 'N/A'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center p-8 text-muted-foreground">
              {loading ? 'Loading dead letter analysis...' : 'No dead letters found (this is good!)'}
            </div>
          )}
        </TabsContent>

        <TabsContent value="worker-issues" className="border rounded-md p-4">
          <h2 className="text-xl font-bold mb-4">Worker Issues</h2>
          {workerIssues.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead>Issue Type</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workerIssues.map((issue, idx) => (
                  <TableRow key={idx}>
                    <TableCell><strong>{issue.worker_name}</strong></TableCell>
                    <TableCell>{issue.issue_type}</TableCell>
                    <TableCell>{new Date(issue.created_at).toLocaleString()}</TableCell>
                    <TableCell className="max-w-md truncate">
                      {JSON.stringify(issue.details)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center p-8 text-muted-foreground">
              {loading ? 'Loading worker issues...' : 'No worker issues found (this is good!)'}
            </div>
          )}
        </TabsContent>
      </Tabs>
      
      <QueueStatus />
    </div>
  );
}

// Queue Status component
function QueueStatus() {
  const [status, setStatus] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const { data, error } = await supabase.rpc('get_queue_metrics');
        
        if (error) throw error;
        
        const statusMap: Record<string, any> = {};
        (data || []).forEach((queue: any) => {
          statusMap[queue.queue_name] = queue;
        });
        
        setStatus(statusMap);
      } catch (error) {
        console.error("Error fetching queue status:", error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const queues = Object.entries(status);

  return (
    <div className="mt-8 border rounded-md p-4">
      <h2 className="text-xl font-bold mb-4">Queue Status</h2>
      
      {loading ? (
        <div className="text-center p-4">Loading queue status...</div>
      ) : queues.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {queues.map(([queueName, data]: [string, any]) => (
            <div key={queueName} className="border rounded-md p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold">{queueName}</h3>
                {data.pending_messages > 0 ? (
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                ) : (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                )}
              </div>
              <div className="mt-2 space-y-1">
                <p className="text-sm">
                  <span className="text-muted-foreground">Pending:</span>{" "}
                  <span className="font-medium">{data.pending_messages || 0}</span>
                </p>
                <p className="text-sm">
                  <span className="text-muted-foreground">Max Retries:</span>{" "}
                  <span className="font-medium">{data.max_retries || 0}</span>
                </p>
                <p className="text-sm">
                  <span className="text-muted-foreground">Oldest Message:</span>{" "}
                  <span className="font-medium">
                    {data.oldest_message_age ? formatDuration(data.oldest_message_age) : 'None'}
                  </span>
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center p-4 text-muted-foreground">
          No queue data available
        </div>
      )}
    </div>
  );
}

// Helper function to format PostgreSQL interval duration
function formatDuration(interval: string): string {
  if (!interval) return "0s";
  
  // Handle PostgreSQL interval format
  const matches = interval.match(/(?:(\d+) days? )?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?/);
  if (!matches) return interval;
  
  const [, days, hours, minutes, seconds] = matches;
  
  const parts = [];
  if (days && parseInt(days) > 0) parts.push(`${days}d`);
  if (hours && parseInt(hours) > 0) parts.push(`${hours}h`);
  if (minutes && parseInt(minutes) > 0) parts.push(`${minutes}m`);
  if (seconds && parseInt(seconds) > 0) parts.push(`${seconds}s`);
  
  return parts.join(" ") || "0s";
}

// TabsList with style wrapper to ensure it shows up correctly
function TabsListWrapper({ children }: { children: React.ReactNode }) {
  return (
    <TabsList className="w-full flex mb-4 overflow-auto">
      {children}
    </TabsList>
  );
}
