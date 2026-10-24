using System;
using System.Globalization;
using System.Threading;

internal static class ProcessFixture
{
    private static int ParseBounded(string value, int minimum, int maximum)
    {
        int parsed;
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) || parsed < minimum || parsed > maximum)
            throw new ArgumentOutOfRangeException("value");
        return parsed;
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "hold")
            {
                Thread.Sleep(ParseBounded(args[1], 60000, 120000));
                return 0;
            }
            if (args.Length == 3 && args[0] == "exit")
            {
                Thread.Sleep(ParseBounded(args[1], 100, 120000));
                return ParseBounded(args[2], 0, 255);
            }
        }
        catch { return 64; }
        return 64;
    }
}
