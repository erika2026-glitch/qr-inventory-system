# Gabay sa Paggamit ng QR Inventory

## 1. Bago gamitin

1. Buksan ang QR Inventory website sa browser ng computer o tablet.
2. Tingnan ang connection status sa itaas ng page. Dapat **Online database connected** para makita at ma-sync ang parehong data sa ibang device.
3. Sa **Settings > Staff Device Name**, ilagay ang pangalan o initials ng gagamit at piliin ang **Save Staff Name**. Gagamitin ito sa mga susunod na scan sa device na iyon.
4. Sa Settings, piliin ang **Download Backup** bago mag-import ng malaking file o gumawa ng maraming pagbabago. Itago ang na-download na JSON backup sa ligtas na lugar.

## 2. I-upload ang pallet list at mag-print ng QR

Gamitin ito para sa mga rolyong parating pa lang at lalagyan ng label bago dumating.

1. Pumunta sa **Settings > Import Items / Pallet List**.
2. Piliin ang pallet-list Excel o CSV file. Dapat may pallet number, description o film type, size, width, net weight, at roll number/count.
3. Basahin ang confirmation bago piliin ang **OK**. Ang pallet-list upload ay **gumagawa lang ng QR labels**. Hindi pa ito nagdadagdag ng inventory o nagpo-post ng Delivery.
4. Dadalhin ka sa **QR Labels**. Hanapin o i-check ang mga label, saka piliin ang **Print Labels**.
5. I-print at idikit ang isang natatanging QR label sa bawat rolyo. Huwag pagpalitin ang labels.

Ang timbang bawat rolyo mula sa pallet list ay average lamang kung total net weight at bilang ng mga rolyo ang nasa file. I-check ang aktuwal na timbang kung kailangan ng eksaktong timbang kada rolyo.

## 3. Kapag dumating ang rolyo: Delivery

1. Tiyaking online ang app kung kailangan makita ng ibang device ang bagong stock.
2. Pumunta sa **Scan**. I-scan ang QR gamit ang camera ng tablet o maglagay ng QR ID/text sa field. Kung camera ang gagamitin, piliin ang **Start Camera Scan** at payagan ang browser na gumamit ng camera.
3. Suriin ang category, lapad/product, gauge, meters, at pallet/roll details na ipinakita.
4. Para sa QR mula sa pallet list, timbangin muna ang rolyo. Tiyakin o itama ang **Pallet Number**, at ilagay ang **Actual Weight (kg)** mula sa timbangan; ang timbang na naka-print sa QR ay estimate lang mula sa total pallet weight at roll count.
5. Piliin ang **Delivery** kapag pisikal nang natanggap ang rolyo. Karaniwan ay isang rolyo bawat QR, kaya bilang na **1** ang gamitin kung hihingan ng bilang.
6. Kapag may katugmang inventory item, idaragdag ang Delivery roon gamit ang aktuwal na timbang. Kung walang katugma, gagawa ang app ng inventory item sa oras ng Delivery.
7. Hintaying lumabas ang matagumpay na confirmation bago magpatuloy sa susunod na rolyo.

Huwag piliin ang Delivery para sa rolyong hindi pa dumarating. Huwag muling i-post ang parehong label kung matagumpay na itong na-record.

## 4. Pag-isyu ng rolyo sa production (Issuance)

1. Pumunta sa **Scan** at i-scan ang QR ng inventory item o ng natanggap nang rolyo.
2. Suriin ang item at ang **Available Rolls**. Para sa individual roll label, mag-isyu ng isang rolyo sa bawat scan.
3. Ilagay ang **Issued For / Job Order**, halimbawa `026-E-065`. Piliin ang mungkahing JO kung lumabas ang tamang customer at job details.
4. Ilagay o tiyakin ang bilang ng rolyo at pangalan ng nag-scan.
5. Piliin ang **Issuance** at hintaying makita ang matagumpay na confirmation.

Hindi papayagan ang issuance na mas marami kaysa sa available na stock. Kailangang may JO o Issued For bago mag-post ng issuance.

## 5. Mga pangunahing screen

- **Dashboard**: kabuuang bilang/timbang, dami ng inventory item, at mga kamakailang galaw.
- **Inventory**: stock kada category at product, kasama ang beginning inventory, deliveries, issuances, ending inventory, at status. Gamitin ang search o category filter para maghanap.
- **Transactions**: talaan ng bawat Delivery at Issuance. Hanapin dito ang QR ID, JO, o pangalan ng nag-scan.
- **Reports**: pumili ng From at To date at category, saka piliin ang **Apply**. Piliin ang **Print Report** para i-print o i-save bilang PDF. Ang nakatakdang linggo ay Lunes hanggang Sabado.
- **Job Order Usage Report**: listahan ng mga rolyong na-issue kada JO. Gamitin ang search o **Export JO Usage** para i-download bilang CSV.
- **QR Labels**: maghanap, mag-print, o mag-reprint ng mga QR label na available sa device/app.
- **Settings**: online connection, pangalan ng staff, backup/restore, at pag-import.

## 6. Kung may maling transaction

Sa **Transactions**, gamitin ang **Void** sa pinakahuling transaction kung pinapayagan ng app. Basahin ang confirmation bago ituloy. Ang pag-void ay nag-aalis ng transaction at nire-recalculate ang stock; hindi ito basta maibabalik. Huwag gamitin ang **Reset Local Data** bilang pang-undo: hindi nito binubura ang online Supabase data, pero nire-reset nito ang lokal na browser data.

## 7. Kapag Offline o may “failed to fetch”

- Buksan ang **Settings > Retry Online Connection** at tingnan ang error/status.
- Ang **Offline/local fallback** ay nangangahulugang maaaring sa browser/device lang ma-save ang pagbabago at hindi pa ito nakikita sa ibang device.
- Iwasang mag-post ng stock movement habang offline kung maraming device ang gumagamit. Ayusin muna ang internet/Supabase connection at tiyaking **Online database connected**.
- Huwag ulit-ulitin ang parehong Delivery o Issuance dahil lang hindi agad lumabas ang confirmation. Suriin muna ang Transactions at Inventory.

## Paalala

- Gumamit ng isang QR label kada rolyo para sa pallet-list workflow.
- I-scan muna bago mag-post at tingnan kung tama ang item, bilang, timbang, at JO.
- Mag-download ng backup nang regular at bago mag-import o mag-reset.
- Ang pagbabago sa source code ay hindi awtomatikong lumalabas sa live website; kailangan itong i-upload sa GitHub at hintaying matapos ang Vercel deployment.
