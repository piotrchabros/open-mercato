# Moduł Manufacturing — scenariusze testów manualnych (UI)

Branch: `manufacturing` · Start: `git checkout manufacturing && yarn dev` → http://localhost:3000/backend

## 0. Setup i feature toggle (fail-closed)

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 0.1 | Moduł niewidoczny bez toggle'a | Zaloguj się jako admin świeżego tenanta; obejrzyj nawigację | Brak grupy „Production/Produkcja" w sidebarze; `/backend/manufacturing` niedostępne |
| 0.2 | Włączenie modułu | Backend → Feature Toggles → utwórz boolean `manufacturing_enabled` = true (lub override per tenant) | Po odświeżeniu grupa nawigacji i strony modułu widoczne |
| 0.3 | Grants ról | `yarn mercato auth sync-role-acls`; utwórz role `technolog`, `planista`, `operator`, `magazynier-lite`, `kierownik` i przypisz userów | Role dostają domyślne grants modułu (widoczne w ustawieniach ról) |
| 0.4 | Backfill słownika braków | `yarn mercato manufacturing seed-scrap-reasons` (idempotentne — odpal 2×) | Słownik `manufacturing-scrap-reasons` z ~5 wpisami; drugi run niczego nie duplikuje |

## 1. Technologia (BOM / marszruty / gniazda) — `/backend/manufacturing/{work-centers,boms,routings}`

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 1.1 | CRUD gniazda | Utwórz gniazdo (typ maszyna, stawka 100/h), edytuj, sprawdź listę | Rekord na liście; edycja działa; walidacje pól |
| 1.2 | BOM z pozycjami | Utwórz produkt w Katalogu (jednostka `kg` + konwersja `g→kg`); utwórz BOM v1 z 2 pozycjami (qty/szt., uom `g`, scrap 10%, jedna fantom) | BOM w statusie draft; pozycje zapisują się i wracają po wejściu w edycję |
| 1.3 | Aktywacja + cykl | Aktywuj BOM v1 (OK); potem zbuduj BOM-y A→B→A i spróbuj aktywować | Aktywacja z cyklem odrzucona z przetłumaczonym komunikatem (422), bez crasha |
| 1.4 | Kopiowanie wersji | „Copy version" na aktywnym BOM; zmień pozycję; aktywuj v2 | v1 automatycznie zarchiwizowana; tylko jedna wersja aktywna per produkt |
| 1.5 | Marszruta | Utwórz marszrutę: 2 operacje (sekw. 10/20, gniazdo, tpz 15 min, tj 60 s/szt., obie „punkt meldowania"); aktywuj | Zapis + aktywacja OK |
| 1.6 | Estymata kosztu | Na BOM: „Cost estimate (catalog list prices)" | Panel z materiałami+robocizną, dopisek o cenach katalogowych; brak ceny komponentu → ostrzeżenie missing price (nie zero po cichu) |
| 1.7 | Optimistic lock | Otwórz ten sam BOM w 2 kartach; zapisz w pierwszej, potem w drugiej | Druga karta dostaje pasek konfliktu (409), bez nadpisania |

## 2. Mini-magazyn — `/backend/manufacturing/stock`

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 2.1 | Przyjęcie ręczne (PW) | „Receive": komponent, 100 `g`, partia `B-001` z datą ważności | On-hand 100, partia widoczna |
| 2.2 | Korekta (bilans otwarcia) | „Adjust": +50 z notatką | On-hand 150; ruch typu adjustment na liście ruchów |
| 2.3 | Import CSV | Wgraj CSV: 2 poprawne wiersze + 1 zepsuty (np. ujemne qty) | Wynik `imported=2, failed=1` z listą błędów per wiersz; stany urosły tylko o poprawne |
| 2.4 | Storno | Na liście ruchów: „Reverse" na przyjęciu | Ruch kompensujący, on-hand wraca; drugie storno tego samego ruchu → 409 |
| 2.5 | Blokada ujemnych stanów | Spróbuj adjustment −999 poniżej stanu | Odrzucone z przetłumaczonym komunikatem |

## 3. Zlecenia produkcyjne — `/backend/manufacturing/orders`

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 3.1 | Ręczne zlecenie + plan | Utwórz zlecenie (produkt z aktywnym BOM+marszrutą, 10 szt., termin +7 dni) → „Plan" | Status draft→planned; numer nadany per organizacja |
| 3.2 | Release z pokryciem | Przyjmij na magazyn wystarczające komponenty → „Release" | Status released; rezerwacje > 0; sekcja braków pusta; operacje/materiały to snapshot |
| 3.3 | Release z brakami | Drugie zlecenie bez stanów → „Release" | Release PRZECHODZI; tabela braków z powodem (`insufficient_stock`/`no_stock_item`) i ilością brakującą |
| 3.4 | Niezmienność snapshotu | Po release zmień BOM (np. qty 999) i aktywuj nową wersję | Materiały released zlecenia BEZ zmian |
| 3.5 | Cancel semantyka | Cancel zlecenia released bez wydań → OK (rezerwacje zwolnione); cancel po częściowym wydaniu materiału (po meldunku z backflush) | Drugi przypadek zablokowany 409 z komunikatem o wydanym materiale |
| 3.6 | Maszyna stanów | Spróbuj „Close" na draft, „Release" na released itd. | Akcje niedostępne/odrzucone zgodnie ze statusem |

## 4. Integracja ze sprzedażą (zakładka na zamówieniu)

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 4.1 | Zakładka Production | Produkt z planning params `make`; utwórz zamówienie sprzedaży z tą pozycją; otwórz detal zamówienia | Zakładka „Production" z przyciskiem tworzenia per linia `make`; linie `buy` bez przycisku |
| 4.2 | Zlecenie z zamówienia | Utwórz zlecenie z zakładki (qty z linii) | Draft z sourceType `sales_order`; widoczny na liście zleceń filtrowanej po źródle |
| 4.3 | Toggle off na zakładce | Wyłącz `manufacturing_enabled` i odśwież detal zamówienia | Zakładka pokazuje komunikat „moduł nieaktywny", nic nie fetchuje |
| 4.4 | MTO auto-draft (opt-in) | Ustaw module config `manufacturing.mto_auto_draft=true` (Configs); utwórz nowe zamówienie z linią make; sprawdź zlecenia | Draft utworzony automatycznie; ponowne dostarczenie eventu nie duplikuje (idempotencja) |

## 5. Hala produkcyjna — `/backend/manufacturing/operator` (najlepiej na tablecie)

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 5.1 | Izolacja operatora | Zaloguj usera z rolą `operator` | Widzi TYLKO panel operatora; inne sekcje backendu nieobecne w nav; bezpośrednie URL-e → 403 |
| 5.2 | Kolejka pracy | Wybierz gniazdo (kafle) | Lista operacji-punktów meldowania zleceń released/in_progress tego gniazda |
| 5.3 | Meldunek częściowy | Tapnij operację → 3 szt. dobre, 1 brak + przyczyna ze słownika → partial | Zlecenie → in_progress; qty na operacji rosną; przy `backflush=true` w planning params — RW komponentów wg snapshotu (sprawdź ruchy na stanie) |
| 5.4 | Meldunek końcowy | Final na OSTATNIEJ operacji-punkcie meldowania | Operacja done; zlecenie completed; PW wyrobu na magazynie (on-hand wyrobu ↑ o qty dobre) |
| 5.5 | Storno meldunku końcowego | (Jako kierownik) Reverse ostatniego meldunku | PW cofnięte, ilości zdjęte, zlecenie WRACA do in_progress; można zameldować poprawiony final |
| 5.6 | Wyścig operatorów | Dwóch userów melduje final tej samej operacji niemal równocześnie | Jeden wygrywa; drugi dostaje przetłumaczony konflikt (nie podwójne PW) |
| 5.7 | Auto-logout | Zostaw panel bez aktywności > 15 min | Automatyczne wylogowanie i redirect do logowania |

## 6. MRP — `/backend/manufacturing/mrp`

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 6.1 | Przebieg ręczny | Planning params: produkt `make` z safety stock > stan; „Run MRP now" | Run pending→completed (progress w top barze); propozycje na detalu przebiegu |
| 6.2 | Propozycje make/buy | Ustaw łańcuch: wyrób make z komponentem buy bez stanów; run | `make` dla wyrobu + `buy` dla komponentu z peggingiem; daty cofnięte o lead time |
| 6.3 | Akceptacja masowa | Zaznacz propozycje make → „Accept" | Draft zlecenia utworzone (sourceType `mrp`); ponowny accept tych samych → skipped, bez duplikatów |
| 6.4 | Carry-over (brak szumu) | Zaakceptuj/odrzuć propozycje; odpal drugi run bez zmiany danych | Domyślny filtr `open` NIE pokazuje ekwiwalentów zaakceptowanych/odrzuconych |
| 6.5 | Export buy CSV | „Export buy CSV" | Plik z otwartymi propozycjami buy; poprawne kolumny |
| 6.6 | Cron respektuje toggle | (Opcjonalnie ze schedulerem) tenant z wyłączonym togglem + planning params | Fan-out pomija tenant — zero nowych runów |

## 7. Analityka — `/backend/manufacturing/analytics`

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 7.1 | Opóźnione/zagrożone | Zlecenie released z terminem wczoraj + inne z terminem za 3 dni | Pierwsze `late` (days late), drugie `at_risk`; completed nie występują |
| 7.2 | Zużycie vs norma | Po scenariuszach 5.3–5.4 otwórz zakładkę consumption | Standard liczony od zameldowanych sztuk (dobre+braki, ze scrap factor); wariancja sensowna (nie ×100) |
| 7.3 | Braki wg przyczyn | Po meldunkach z brakami | Agregaty per przyczyna ze słownika + kubełek „unspecified" dla braków bez przyczyny |

## 8. Przekrojowe

| # | Scenariusz | Kroki | Oczekiwane |
|---|-----------|-------|-----------|
| 8.1 | Izolacja organizacji | Dwie organizacje w tenancie; dane w org A; przełącz na org B | Listy/stany/zlecenia org A niewidoczne w org B; w trybie „All Organizations" widać oba i detale się otwierają (bez fałszywych 404) |
| 8.2 | Search (Cmd+K) | Wyszukaj numer zlecenia i nazwę BOM | Wyniki linkują do detali; ruchy magazynowe/meldunki NIE są indeksowane |
| 8.3 | Widoczność wg ról | Zaloguj kolejno: technolog / planista / magazynier-lite / kierownik | Każdy widzi tylko swoje sekcje (technolog: technologia; planista: zlecenia+MRP; magazynier: stany; kierownik: raporty) |
| 8.4 | i18n | Przełącz język na PL | Całość UI modułu po polsku, bez surowych kluczy ani `[internal]` |
