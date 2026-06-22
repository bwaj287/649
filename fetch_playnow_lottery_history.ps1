param(
    [datetime]$EndDate = (Get-Date),
    [int]$YearsBack = 10,
    [string]$OutputDir = 'F:\649'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ScheduledDates {
    param(
        [datetime]$StartDate,
        [datetime]$EndDate,
        [System.DayOfWeek[]]$DaysOfWeek
    )

    $dates = New-Object System.Collections.Generic.List[datetime]
    $cursor = $StartDate.Date
    $end = $EndDate.Date

    while ($cursor -le $end) {
        if ($DaysOfWeek -contains $cursor.DayOfWeek) {
            $dates.Add($cursor)
        }

        $cursor = $cursor.AddDays(1)
    }

    return $dates
}

function Invoke-PlayNowJson {
    param(
        [string]$Uri,
        [int]$MaxAttempts = 3
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 30
            return $response.Content | ConvertFrom-Json
        } catch {
            if ($attempt -eq $MaxAttempts) {
                throw
            }

            Start-Sleep -Milliseconds (500 * $attempt)
        }
    }
}

function Convert-DrawDateToIso {
    param(
        [string]$DrawDateText,
        [datetime]$FallbackDate
    )

    if ([string]::IsNullOrWhiteSpace($DrawDateText)) {
        return $FallbackDate.ToString('yyyy-MM-dd')
    }

    try {
        return [datetime]::ParseExact(
            $DrawDateText,
            'MMM d, yyyy',
            [System.Globalization.CultureInfo]::InvariantCulture
        ).ToString('yyyy-MM-dd')
    } catch {
        return $FallbackDate.ToString('yyyy-MM-dd')
    }
}

function Join-IntList {
    param(
        $Values,
        [string]$Separator = ' '
    )

    if ($null -eq $Values) {
        return ''
    }

    return (($Values | ForEach-Object { [string]$_ }) -join $Separator)
}

function Convert-GuaranteedPrizeNumber {
    param($GuaranteedPrizeNumber)

    if ($null -eq $GuaranteedPrizeNumber -or $null -eq $GuaranteedPrizeNumber.drawNbrs) {
        return ''
    }

    $digits = @($GuaranteedPrizeNumber.drawNbrs | ForEach-Object { [string]$_ })
    if ($digits.Count -lt 10) {
        return ($digits -join '')
    }

    return ($digits[0..6] -join '') + '-' + ($digits[7..9] -join '')
}

function Convert-BonusDraw {
    param($BonusDraw)

    if ($null -eq $BonusDraw) {
        return ''
    }

    return Join-IntList -Values $BonusDraw -Separator '-'
}

function Get-Lotto649History {
    param(
        [datetime]$StartDate,
        [datetime]$EndDate
    )

    $dates = Get-ScheduledDates -StartDate $StartDate -EndDate $EndDate -DaysOfWeek @(
        [System.DayOfWeek]::Wednesday,
        [System.DayOfWeek]::Saturday
    )

    $rows = New-Object System.Collections.Generic.List[object]

    foreach ($date in $dates) {
        $uri = "https://www.playnow.com/services2/lotto/draw/six49/$($date.ToString('yyyy-MM-dd'))"
        $data = Invoke-PlayNowJson -Uri $uri
        $goldBallRows = @($data.gpNumbers)

        $rows.Add([pscustomobject]@{
            game                         = 'Lotto 649'
            source                       = 'PlayNow BCLC official'
            source_url                   = $uri
            request_date                 = $date.ToString('yyyy-MM-dd')
            draw_date                    = Convert-DrawDateToIso -DrawDateText $data.drawDate -FallbackDate $date
            draw_day                     = $date.DayOfWeek.ToString()
            draw_number                  = $data.drawNbr
            main_1                       = $data.drawNbrs[0]
            main_2                       = $data.drawNbrs[1]
            main_3                       = $data.drawNbrs[2]
            main_4                       = $data.drawNbrs[3]
            main_5                       = $data.drawNbrs[4]
            main_6                       = $data.drawNbrs[5]
            bonus_number                 = $data.bonusNbr
            extra_1                      = if ($data.extraNbrs.Count -ge 1) { $data.extraNbrs[0] } else { $null }
            extra_2                      = if ($data.extraNbrs.Count -ge 2) { $data.extraNbrs[1] } else { $null }
            extra_3                      = if ($data.extraNbrs.Count -ge 3) { $data.extraNbrs[2] } else { $null }
            extra_4                      = if ($data.extraNbrs.Count -ge 4) { $data.extraNbrs[3] } else { $null }
            draw_version                 = $data.drawVersion
            gold_ball_draw_count         = $goldBallRows.Count
            gold_ball_numbers            = ($goldBallRows | ForEach-Object { Convert-GuaranteedPrizeNumber $_ }) -join ';'
            gold_ball_drawn              = [bool]($goldBallRows | Where-Object { $_.goldBallDrawn })
            gold_ball_prize_amounts      = ($goldBallRows | ForEach-Object { $_.goldBallPrizeAmount }) -join ';'
            white_ball_prize_amounts     = ($goldBallRows | ForEach-Object { $_.whiteBallPrizeAmount }) -join ';'
            gold_ball_prize_descriptions = ($goldBallRows | ForEach-Object { $_.prizeDesc }) -join ';'
            additional_prize_numbers     = (@($data.gpAdditionalNumbers) | ForEach-Object { Join-IntList -Values $_ -Separator '-' }) -join ';'
        })
    }

    return $rows
}

function Get-LottoMaxHistory {
    param(
        [datetime]$StartDate,
        [datetime]$EndDate
    )

    $dates = Get-ScheduledDates -StartDate $StartDate -EndDate $EndDate -DaysOfWeek @(
        [System.DayOfWeek]::Tuesday,
        [System.DayOfWeek]::Friday
    )

    $rows = New-Object System.Collections.Generic.List[object]

    foreach ($date in $dates) {
        $uri = "https://www.playnow.com/services2/lotto/draw/lmax/$($date.ToString('yyyy-MM-dd'))"
        $data = Invoke-PlayNowJson -Uri $uri
        $bonusDraws = @($data.bonusDraws)

        $rows.Add([pscustomobject]@{
            game                     = 'Lotto Max'
            source                   = 'PlayNow BCLC official'
            source_url               = $uri
            request_date             = $date.ToString('yyyy-MM-dd')
            draw_date                = Convert-DrawDateToIso -DrawDateText $data.drawDate -FallbackDate $date
            draw_day                 = $date.DayOfWeek.ToString()
            draw_number              = $data.drawNbr
            main_1                   = $data.drawNbrs[0]
            main_2                   = $data.drawNbrs[1]
            main_3                   = $data.drawNbrs[2]
            main_4                   = $data.drawNbrs[3]
            main_5                   = $data.drawNbrs[4]
            main_6                   = $data.drawNbrs[5]
            main_7                   = $data.drawNbrs[6]
            bonus_number             = $data.bonusNbr
            extra_1                  = if ($data.extraNbrs.Count -ge 1) { $data.extraNbrs[0] } else { $null }
            extra_2                  = if ($data.extraNbrs.Count -ge 2) { $data.extraNbrs[1] } else { $null }
            extra_3                  = if ($data.extraNbrs.Count -ge 3) { $data.extraNbrs[2] } else { $null }
            extra_4                  = if ($data.extraNbrs.Count -ge 4) { $data.extraNbrs[3] } else { $null }
            draw_version             = $data.drawVersion
            bonus_draw_count         = $bonusDraws.Count
            bonus_draw_numbers       = ($bonusDraws | ForEach-Object { Convert-BonusDraw $_ }) -join ';'
            max_million_pending      = $data.maxMillionPending
            max_plus_count           = @($data.gameBreakdown | Where-Object { $_.prizeDiv -eq 16 }).Count
            max_plus_amounts         = (@($data.gameBreakdown | Where-Object { $_.prizeDiv -eq 16 } | ForEach-Object { $_.prizeAmount }) | Select-Object -Unique) -join ';'
        })
    }

    return $rows
}

$startDate = $EndDate.Date.AddYears(-$YearsBack)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$lotto649Rows = Get-Lotto649History -StartDate $startDate -EndDate $EndDate
$lottoMaxRows = Get-LottoMaxHistory -StartDate $startDate -EndDate $EndDate

$rangeLabel = '{0}_to_{1}' -f $startDate.ToString('yyyy-MM-dd'), $EndDate.ToString('yyyy-MM-dd')
$lotto649Csv = Join-Path $OutputDir "lotto649_$rangeLabel.csv"
$lottoMaxCsv = Join-Path $OutputDir "lottomax_$rangeLabel.csv"

$lotto649Rows | Export-Csv -Path $lotto649Csv -NoTypeInformation -Encoding UTF8
$lottoMaxRows | Export-Csv -Path $lottoMaxCsv -NoTypeInformation -Encoding UTF8

[pscustomobject]@{
    output_dir         = $OutputDir
    start_date         = $startDate.ToString('yyyy-MM-dd')
    end_date           = $EndDate.ToString('yyyy-MM-dd')
    lotto649_rows      = $lotto649Rows.Count
    lotto649_csv       = $lotto649Csv
    lottomax_rows      = $lottoMaxRows.Count
    lottomax_csv       = $lottoMaxCsv
} | ConvertTo-Json
