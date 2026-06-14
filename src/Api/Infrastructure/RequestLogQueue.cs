using System.Threading.Channels;
using Ccusage.Api.Data.Entities;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// A bounded in-memory hand-off between the request pipeline and the background writer. The
/// middleware never blocks on the database; if the buffer is full (sustained burst) the newest
/// entries are dropped rather than slowing requests or growing memory without bound.
/// </summary>
public sealed class RequestLogQueue
{
    private readonly Channel<RequestLog> _channel = Channel.CreateBounded<RequestLog>(
        new BoundedChannelOptions(2000)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
        });

    /// <summary>Non-blocking enqueue; returns false if the buffer is full (entry dropped).</summary>
    public bool TryEnqueue(RequestLog entry) => _channel.Writer.TryWrite(entry);

    public ChannelReader<RequestLog> Reader => _channel.Reader;
}
