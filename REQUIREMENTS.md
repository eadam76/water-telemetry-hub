# Vízellátó rendszer felügyelet – követelmények

## Hatókör

ESP32/ESPHome alapú felügyeleti rendszer az aknában lévő vízellátó rendszerhez. A Home Assistant biztosítja a historizálást, statisztikát és megjelenítést, de az ESP működése nem függhet a HA vagy a hálózat elérhetőségétől.

## Impulzusszámláló modul

### Funkcionális követelmények

- Minden érvényes vízóraimpulzust pontosan egyszer számoljon.
- Azonos, újrafelhasználható modulstruktúrával egy vagy több impulzusos vízóra legyen kezelhető.
- Aktuális térfogatáram megadása `L/min` egységben.
- Összesített fogyasztás megadása `m³` egységben.
- Összes impulzusszám megadása diagnosztikai célra.
- Impulzusráta megadása diagnosztikai célra.
- A rendszer által mutatott összesített óraállás kézzel hozzáigazítható legyen a fizikai vízóra aktuális állásához.
- A kézi szinkronizálás legyen elérhető Home Assistantból és lehetőség szerint az ESP saját webes felületéről is.
- Kézi óraállás-szinkronizáláskor az új érték azonnal kerüljön perzisztens tárolásba; ne várjon a normál checkpoint időközre.

### Perzisztencia és hibakezelés

- Az aktuális impulzusszám és összesített fogyasztás elsődleges adatforrása az ESP.
- A működés nem függhet a Home Assistant, MQTT, API vagy Wi-Fi elérhetőségétől.
- Normál működés közben az aktuális számláló RAM-ban legyen vezetve.
- Az összesített számláló rendszeresen kerüljön checkpointként az ESP flash/NVS tárába.
- Alapértelmezett checkpoint időköz: `60 s`.
- Váratlan tápvesztéskor legfeljebb az utolsó checkpoint óta érkezett impulzusok veszhetnek el.
- Újraindítás után a számlálás automatikusan az utolsó perzisztensen mentett értékről folytatódjon.
- Az első implementáció ne igényeljen külső FRAM-ot vagy más kiegészítő nem felejtő memóriát.

### Home Assistant adatmodell

Üzemi entitások:

- `Térfogatáram`
  - mértékegység: `L/min`
  - `state_class: measurement`
- `Összes fogyasztás`
  - mértékegység: `m³`
  - `device_class: water`
  - `state_class: total_increasing`

Diagnosztikai entitások:

- `Impulzusráta`
  - mértékegység: `impulzus/min`
  - `state_class: measurement`
- `Összes impulzus`
  - mértékegység: `impulzus`
  - `state_class: total_increasing`

Beállító/szerviz entitások:

- fizikai vízóra állásának megadása (`m³`)
- óraállás alkalmazása/szinkronizálása

### Idősoros adatok és statisztikák

- Az ESP nem tárol hosszú távú idősoros adatokat.
- Az idősoros tárolás, statisztika, aggregáció és vizualizáció a Home Assistant feladata.
- Az aktuális térfogatáram legyen látható és historizált a Home Assistantban.
- Az összesített fogyasztás legyen historizált a Home Assistantban.
- A vízfogyasztás bármely tetszőleges időintervallumra meghatározható legyen.
- Az órás, napi, heti és havi fogyasztás Home Assistant oldali aggregáció.
- Home Assistant kiesése alatt az ESP folytassa a számlálást.
- A Home Assistant kiesése alatti részletes térfogatáram-idősor ESP oldali megőrzése nem követelmény.
- A Home Assistant visszakapcsolódásakor az ESP aktuális abszolút összesített értéke legyen az irányadó.

### Kalibráció

- Az impulzus–térfogat átváltás legyen konfigurálható.
- Az implementáció használjon egyértelmű paramétert, például `liters_per_pulse`.
- Az impulzusbemenet szűrése/pergésmentesítése legyen a fizikai vízórához konfigurálható.

## Kezdeti implementációs döntések

- ESPHome `pulse_meter` az impulzusérzékeléshez és impulzusráta-méréshez.
- ESPHome preferences/NVS a checkpointok perzisztens tárolásához.
- Normál működéskor a flash-írás gyakorisága konfigurálható checkpoint/flush stratégiával legyen korlátozva.
- Kézi óraállás-szinkronizáláskor az új érték azonnal kerüljön perzisztens tárolásba.
