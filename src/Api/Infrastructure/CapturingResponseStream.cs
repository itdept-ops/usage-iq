using System.Text;

namespace Ccusage.Api.Infrastructure;

/// <summary>
/// A write-through stream wrapper: forwards every write to the real response stream while keeping
/// a copy of only the first <c>maxCapture</c> bytes (so large responses like CSV exports are never
/// fully buffered) and a running total of bytes written.
/// </summary>
public sealed class CapturingResponseStream(Stream inner, int maxCapture) : Stream
{
    private readonly MemoryStream _capture = new();
    public long TotalBytes { get; private set; }

    private void Capture(ReadOnlySpan<byte> data)
    {
        TotalBytes += data.Length;
        var room = maxCapture - (int)_capture.Length;
        if (room > 0) _capture.Write(data[..Math.Min(room, data.Length)]);
    }

    public string GetCapturedText()
    {
        var bytes = _capture.ToArray();
        var truncated = TotalBytes > bytes.Length;

        // If the capture was cut at the byte window, the tail may end mid multi-byte UTF-8
        // sequence (decoding to a replacement char that can disrupt a redaction regex anchor)
        // and, more importantly, a secret whose opening quote is inside the window but whose
        // closing quote fell just past it is a partial value that would slip past a regex that
        // only matches COMPLETE quoted values. Fail closed: drop the trailing incomplete UTF-8
        // sequence and append a marker so any dangling partial field is not left as a clean,
        // unredacted quoted value.
        if (truncated)
        {
            var len = bytes.Length;
            // Walk back over UTF-8 continuation bytes (10xxxxxx) to the start of the last
            // (possibly incomplete) code point, then drop it if it is not fully present.
            var i = len - 1;
            while (i >= 0 && (bytes[i] & 0xC0) == 0x80) i--;
            if (i >= 0)
            {
                var lead = bytes[i];
                var expected = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
                if (len - i < expected) len = i; // incomplete trailing sequence: drop it
            }

            return Encoding.UTF8.GetString(bytes, 0, len) + "\"…[truncated]";
        }

        return Encoding.UTF8.GetString(bytes);
    }

    public override void Write(byte[] buffer, int offset, int count)
    {
        Capture(buffer.AsSpan(offset, count));
        inner.Write(buffer, offset, count);
    }

    public override async Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct)
    {
        Capture(buffer.AsSpan(offset, count));
        await inner.WriteAsync(buffer.AsMemory(offset, count), ct);
    }

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        Capture(buffer.Span);
        await inner.WriteAsync(buffer, ct);
    }

    public override void Flush() => inner.Flush();
    public override Task FlushAsync(CancellationToken ct) => inner.FlushAsync(ct);

    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => inner.Length;
    public override long Position { get => inner.Position; set => inner.Position = value; }
    public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
    public override void SetLength(long value) => inner.SetLength(value);
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    // Dispose only our capture buffer — `inner` is the real response body, owned by the server.
    protected override void Dispose(bool disposing)
    {
        if (disposing) _capture.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await _capture.DisposeAsync();
        await base.DisposeAsync();
    }
}
